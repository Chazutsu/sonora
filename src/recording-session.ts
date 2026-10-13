export type RecordingPhase = "idle" | "requesting" | "recording" | "stopping" | "saving";
export type RecordingErrorStage = "access" | "recording" | "saving";

export interface RecordingTrack {
	stop(): void;
}

export interface RecordingStream {
	getTracks(): RecordingTrack[];
}

export interface RecordingChunkEvent {
	data: Blob;
}

export interface RecordingErrorEvent {
	error?: unknown;
}

export interface RecordingRecorder {
	readonly mimeType: string;
	readonly state: string;
	addEventListener(type: "dataavailable", listener: (event: RecordingChunkEvent) => void): void;
	addEventListener(type: "stop", listener: () => void): void;
	addEventListener(type: "error", listener: (event: RecordingErrorEvent) => void): void;
	removeEventListener(type: "dataavailable", listener: (event: RecordingChunkEvent) => void): void;
	removeEventListener(type: "stop", listener: () => void): void;
	removeEventListener(type: "error", listener: (event: RecordingErrorEvent) => void): void;
	start(timeslice?: number): void;
	requestData?(): void;
	stop(): void;
}

export interface RecordingPayload<Context extends Readonly<Record<string, unknown>>> {
	readonly recoveryId: string;
	readonly outputPath?: string;
	readonly context: Readonly<Context>;
	readonly blob: Blob;
	readonly mimeType: string;
	readonly size: number;
	readonly startedAt: number;
	readonly stoppedAt: number;
	readonly durationMs: number;
	readonly limit: "duration" | "size" | null;
}

export interface RecordingSessionOptions<Context extends Readonly<Record<string, unknown>>> {
	requestStream(): Promise<RecordingStream>;
	createRecorder(stream: RecordingStream): RecordingRecorder;
	onSave(payload: Readonly<RecordingPayload<Context>>): void | Promise<void>;
	onCheckpointStart?(input: {
		readonly sessionId: string;
		readonly context: Readonly<Context>;
		readonly mimeType: string;
		readonly startedAt: number;
		readonly outputPath?: string;
	}): Promise<void>;
	onCheckpointPart?(input: {
		readonly sessionId: string;
		readonly index: number;
		readonly blob: Blob;
	}): Promise<void>;
	onCheckpointReady?(payload: Readonly<RecordingPayload<Context>>): Promise<void>;
	onSaveConfirmed?(sessionId: string): Promise<void>;
	onPhaseChange?(phase: RecordingPhase): void;
	onError?(error: unknown, stage: RecordingErrorStage): void;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	maxDurationMs?: number;
	maxBytes?: number;
	timesliceMs?: number;
	createSessionId?: () => string;
	resolveOutputPath?: (input: {
		readonly context: Readonly<Context>;
		readonly mimeType: string;
		readonly startedAt: number;
		readonly sessionId: string;
	}) => string;
}

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMESLICE_MS = 1_000;

export class RecordingSession<Context extends Readonly<Record<string, unknown>>> {
	private phase: RecordingPhase = "idle";
	private generation = 0;
	private disposed = false;
	private recorder: RecordingRecorder | null = null;
	private stream: RecordingStream | null = null;
	private chunks: Blob[] = [];
	private bytes = 0;
	private context: Readonly<Context> | null = null;
	private startedAt = 0;
	private timer: unknown = null;
	private stopRequested = false;
	private limit: RecordingPayload<Context>["limit"] = null;
	private dataListener: ((event: RecordingChunkEvent) => void) | null = null;
	private stopListener: (() => void) | null = null;
	private errorListener: ((event: RecordingErrorEvent) => void) | null = null;
	private recoveryId = "";
	private checkpointIndex = 0;
	private checkpointQueue = Promise.resolve();
	private checkpointError: unknown = null;
	private outputPath: string | undefined;
	private unloading = false;

	constructor(private readonly options: RecordingSessionOptions<Context>) {}

	currentPhase(): RecordingPhase {
		return this.phase;
	}

	async start(context: Context): Promise<boolean> {
		if (this.disposed || this.phase !== "idle") return false;

		const generation = ++this.generation;
		let errorStage: RecordingErrorStage = "access";
		this.context = Object.freeze({ ...context }) as Readonly<Context>;
		this.transition("requesting");

		try {
			const stream = await this.options.requestStream();
			if (!this.isCurrent(generation) || this.currentPhase() !== "requesting") {
				this.stopTracks(stream);
				return false;
			}

			this.stream = stream;
			errorStage = "recording";
			const recorder = this.options.createRecorder(stream);
			this.recorder = recorder;
			this.chunks = [];
			this.bytes = 0;
			this.stopRequested = false;
			this.limit = null;
			this.startedAt = this.now();
			this.recoveryId = this.options.createSessionId?.() ?? crypto.randomUUID();
			this.checkpointIndex = 0;
			this.checkpointError = null;
			this.checkpointQueue = Promise.resolve();
			this.outputPath = this.options.resolveOutputPath?.({
				context: this.context,
				mimeType: recorder.mimeType || "audio/webm",
				startedAt: this.startedAt,
				sessionId: this.recoveryId,
			});
			await this.options.onCheckpointStart?.({
				sessionId: this.recoveryId,
				context: this.context,
				mimeType: recorder.mimeType || "audio/webm",
				startedAt: this.startedAt,
				outputPath: this.outputPath,
			});

			this.dataListener = (event) => this.receiveChunk(generation, event.data);
			this.stopListener = () => void this.finish(generation);
			this.errorListener = (event) => this.fail(generation, event.error ?? event, "recording");
			recorder.addEventListener("dataavailable", this.dataListener);
			recorder.addEventListener("stop", this.stopListener);
			recorder.addEventListener("error", this.errorListener);
			recorder.start(this.options.timesliceMs ?? DEFAULT_TIMESLICE_MS);
			this.transition("recording");
			this.timer = this.setTimer(() => {
				if (!this.isCurrent(generation)) return;
				this.limit = "duration";
				this.requestStop(generation);
			}, this.options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
			return true;
		} catch (error) {
			if (this.isCurrent(generation)) this.fail(generation, error, errorStage);
			return false;
		}
	}

	stop(): boolean {
		if (this.disposed || (this.phase !== "recording" && this.phase !== "stopping")) return false;
		return this.requestStop(this.generation);
	}

	unload(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unloading = true;
		this.clearLimitTimer();
		const recorder = this.recorder;
		if (recorder?.state === "recording" && !this.stopRequested) {
			this.stopRequested = true;
			this.transition("stopping");
			try {
				recorder.requestData?.();
				recorder.stop();
			} catch {
				// Completed checkpoints remain recoverable if a browser rejects the tail flush.
			}
		}
		this.stopTracks(this.stream);
	}

	private receiveChunk(generation: number, chunk: Blob): void {
		if (
			!this.isSessionGeneration(generation) ||
			(this.phase !== "recording" && this.phase !== "stopping") ||
			chunk.size === 0
		)
			return;
		const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
		if (this.bytes + chunk.size > maxBytes) {
			this.limit = "size";
			this.requestStop(generation);
			return;
		}
		this.chunks.push(chunk);
		this.bytes += chunk.size;
		if (this.options.onCheckpointPart) {
			const index = this.checkpointIndex++;
			this.checkpointQueue = this.checkpointQueue
				.then(() =>
					this.options.onCheckpointPart?.({ sessionId: this.recoveryId, index, blob: chunk }),
				)
				.catch((error) => {
					this.checkpointError = error;
					this.requestStop(generation);
				});
		}
	}

	private requestStop(generation: number): boolean {
		if (!this.isCurrent(generation) || this.stopRequested || !this.recorder) return false;
		this.stopRequested = true;
		this.clearLimitTimer();
		this.transition("stopping");
		if (this.recorder.state !== "inactive") {
			try {
				this.recorder.stop();
			} catch (error) {
				this.fail(generation, error, "recording");
			}
		} else {
			void this.finish(generation);
		}
		return true;
	}

	private async finish(generation: number): Promise<void> {
		if (!this.isSessionGeneration(generation) || this.phase !== "stopping") return;
		const recorder = this.recorder;
		const context = this.context;
		const stoppedAt = this.now();
		const chunks = [...this.chunks];
		const mimeType = recorder?.mimeType || chunks[0]?.type || "audio/webm";
		this.detachRecorder();
		this.stopTracks(this.stream);
		this.stream = null;

		if (!context) {
			this.reset();
			return;
		}

		this.transition("saving");
		const blob = new Blob(chunks, { type: mimeType });
		const payload = Object.freeze({
			recoveryId: this.recoveryId,
			outputPath: this.outputPath,
			context,
			blob,
			mimeType,
			size: blob.size,
			startedAt: this.startedAt,
			stoppedAt,
			durationMs: Math.max(0, stoppedAt - this.startedAt),
			limit: this.limit,
		}) as Readonly<RecordingPayload<Context>>;

		try {
			await this.checkpointQueue;
			if (this.checkpointError) throw this.checkpointError;
			await this.options.onCheckpointReady?.(payload);
			if (this.unloading) return;
			await this.options.onSave(payload);
			await this.options.onSaveConfirmed?.(payload.recoveryId);
		} catch (error) {
			if (this.isCurrent(generation)) this.options.onError?.(error, "saving");
		} finally {
			if (this.isSessionGeneration(generation)) this.reset();
		}
	}

	private fail(generation: number, error: unknown, stage: RecordingErrorStage): void {
		if (!this.isCurrent(generation)) return;
		this.clearLimitTimer();
		this.detachRecorder();
		this.stopTracks(this.stream);
		this.stream = null;
		this.options.onError?.(error, stage);
		this.reset();
	}

	private isCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private isSessionGeneration(generation: number): boolean {
		return generation === this.generation;
	}

	private transition(phase: RecordingPhase): void {
		this.phase = phase;
		this.options.onPhaseChange?.(phase);
	}

	private reset(): void {
		this.clearLimitTimer();
		this.recorder = null;
		this.stream = null;
		this.chunks = [];
		this.bytes = 0;
		this.context = null;
		this.startedAt = 0;
		this.stopRequested = false;
		this.limit = null;
		this.recoveryId = "";
		this.checkpointIndex = 0;
		this.checkpointQueue = Promise.resolve();
		this.checkpointError = null;
		this.outputPath = undefined;
		this.unloading = false;
		this.transition("idle");
	}

	private detachRecorder(): void {
		if (!this.recorder) return;
		if (this.dataListener) this.recorder.removeEventListener("dataavailable", this.dataListener);
		if (this.stopListener) this.recorder.removeEventListener("stop", this.stopListener);
		if (this.errorListener) this.recorder.removeEventListener("error", this.errorListener);
		this.dataListener = null;
		this.stopListener = null;
		this.errorListener = null;
	}

	private stopTracks(stream: RecordingStream | null): void {
		for (const track of stream?.getTracks() ?? []) {
			try {
				track.stop();
			} catch {
				// A track may already have been closed by the browser.
			}
		}
	}

	private clearLimitTimer(): void {
		if (this.timer === null) return;
		(this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
		this.timer = null;
	}

	private setTimer(callback: () => void, delayMs: number): unknown {
		return (this.options.setTimer ?? setTimeout)(callback, delayMs);
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}
