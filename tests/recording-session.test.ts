import { describe, expect, it, vi } from "vitest";
import {
	RecordingSession,
	type RecordingRecorder,
	type RecordingStream,
} from "../src/recording-session";

class TestRecorder implements RecordingRecorder {
	mimeType = "audio/webm";
	state = "inactive";
	private dataListeners = new Set<(event: { data: Blob }) => void>();
	private stopListeners = new Set<() => void>();
	private errorListeners = new Set<(event: { error?: unknown }) => void>();
	addEventListener(
		type: "dataavailable" | "stop" | "error",
		listener:
			| ((event: { data: Blob }) => void)
			| (() => void)
			| ((event: { error?: unknown }) => void),
	) {
		if (type === "dataavailable")
			this.dataListeners.add(listener as (event: { data: Blob }) => void);
		else if (type === "stop") this.stopListeners.add(listener as () => void);
		else this.errorListeners.add(listener as (event: { error?: unknown }) => void);
	}
	removeEventListener(
		type: "dataavailable" | "stop" | "error",
		listener:
			| ((event: { data: Blob }) => void)
			| (() => void)
			| ((event: { error?: unknown }) => void),
	) {
		if (type === "dataavailable")
			this.dataListeners.delete(listener as (event: { data: Blob }) => void);
		else if (type === "stop") this.stopListeners.delete(listener as () => void);
		else this.errorListeners.delete(listener as (event: { error?: unknown }) => void);
	}
	start = vi.fn((timeslice?: number) => {
		this.state = "recording";
		void timeslice;
	});
	requestData = vi.fn();
	stop = vi.fn(() => {
		this.state = "inactive";
	});
	emit(size: number) {
		const event = { data: new Blob([new Uint8Array(size)], { type: this.mimeType }) };
		for (const listener of this.dataListeners) listener(event);
	}
	finish() {
		for (const listener of this.stopListeners) listener();
	}
	captureStopListener() {
		return this.stopListeners.values().next().value;
	}
}

function fixture(overrides: { maxBytes?: number; maxDurationMs?: number } = {}) {
	const track = { stop: vi.fn() };
	const stream: RecordingStream = { getTracks: () => [track] };
	const recorder = new TestRecorder();
	const onSave = vi.fn();
	const phases: string[] = [];
	const session = new RecordingSession({
		requestStream: vi.fn(async () => stream),
		createRecorder: () => recorder,
		onSave,
		onPhaseChange: (phase) => phases.push(phase),
		...overrides,
	});
	return { onSave, phases, recorder, session, stream, track };
}

describe("RecordingSession", () => {
	it("reports microphone request failures as access errors", async () => {
		const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
		const onError = vi.fn();
		const session = new RecordingSession({
			requestStream: vi.fn().mockRejectedValue(denied),
			createRecorder: vi.fn(),
			onSave: vi.fn(),
			onError,
		});

		expect(await session.start({ itemId: "item-1" })).toBe(false);
		expect(onError).toHaveBeenCalledWith(denied, "access");
		expect(session.currentPhase()).toBe("idle");
	});

	it("reports durable-save failures separately from microphone access", async () => {
		const { recorder } = fixture();
		const onError = vi.fn();
		const failing = new RecordingSession({
			requestStream: vi.fn(async () => ({ getTracks: () => [] })),
			createRecorder: () => recorder,
			onSave: vi.fn().mockRejectedValue(new Error("save failed")),
			onError,
		});

		await failing.start({ itemId: "item-1" });
		failing.stop();
		recorder.finish();
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error), "saving"));
		expect(failing.currentPhase()).toBe("idle");
	});

	it("requests one-second chunks so the durable tail loss window stays small", async () => {
		const { onSave, recorder, session, track } = fixture();
		await session.start({ itemId: "item-1", title: "Note" });
		recorder.emit(3);
		expect(recorder.start).toHaveBeenCalledWith(1_000);
		expect(session.stop()).toBe(true);
		expect(session.stop()).toBe(false);
		recorder.finish();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		const payload = onSave.mock.calls[0]?.[0];
		expect(payload).toMatchObject({ size: 3, mimeType: "audio/webm", limit: null });
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload.context)).toBe(true);
		expect(track.stop).toHaveBeenCalledOnce();
		expect(session.currentPhase()).toBe("idle");
	});

	it("keeps the final dataavailable chunk emitted after stop", async () => {
		const { onSave, recorder, session } = fixture();
		await session.start({ itemId: "item-1" });
		expect(session.stop()).toBe(true);
		recorder.emit(7);
		recorder.finish();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({ size: 7 });
	});

	it("stops at the size limit without retaining the overflowing chunk", async () => {
		const { onSave, recorder, session } = fixture({ maxBytes: 5 });
		await session.start({ itemId: "item-1" });
		recorder.emit(4);
		recorder.emit(2);
		expect(recorder.stop).toHaveBeenCalledOnce();
		recorder.finish();
		await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({ size: 4, limit: "size" });
	});

	it("stops after the duration limit", async () => {
		vi.useFakeTimers();
		const { onSave, recorder, session } = fixture({ maxDurationMs: 25 });
		await session.start({ itemId: "item-1" });
		await vi.advanceTimersByTimeAsync(25);
		expect(recorder.stop).toHaveBeenCalledOnce();
		recorder.finish();
		await vi.runAllTimersAsync();
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({ limit: "duration" });
		vi.useRealTimers();
	});

	it("invalidates late permission and stop callbacks after unload", async () => {
		let resolveStream!: (stream: RecordingStream) => void;
		const track = { stop: vi.fn() };
		const recorder = new TestRecorder();
		const onSave = vi.fn();
		const session = new RecordingSession({
			requestStream: () => new Promise((resolve) => (resolveStream = resolve)),
			createRecorder: () => recorder,
			onSave,
		});
		const starting = session.start({ itemId: "item-1" });
		session.unload();
		resolveStream({ getTracks: () => [track] });
		expect(await starting).toBe(false);
		expect(track.stop).toHaveBeenCalledOnce();
		recorder.finish();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("flushes an active recorder on unload without running the normal save", async () => {
		const { onSave, recorder, session, track } = fixture();
		await session.start({ itemId: "item-1" });
		const lateStop = recorder.captureStopListener();
		session.unload();
		expect(recorder.requestData).toHaveBeenCalledOnce();
		expect(recorder.stop).toHaveBeenCalledOnce();
		expect(track.stop).toHaveBeenCalledOnce();
		lateStop?.();
		expect(onSave).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(session.currentPhase()).toBe("idle"));
	});

	it("checkpoints the final requestData tail during unload and marks it ready", async () => {
		const recorder = new TestRecorder();
		const parts: number[] = [];
		const ready = vi.fn(async () => undefined);
		recorder.requestData.mockImplementation(() => recorder.emit(4));
		const session = new RecordingSession({
			requestStream: async () => ({ getTracks: () => [] }),
			createRecorder: () => recorder,
			onSave: vi.fn(),
			onCheckpointStart: async () => undefined,
			onCheckpointPart: async ({ blob }) => void parts.push(blob.size),
			onCheckpointReady: ready,
		});
		await session.start({ itemId: "item-1" });
		const stop = recorder.captureStopListener();
		session.unload();
		stop?.();
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
		expect(parts).toEqual([4]);
		expect(ready).toHaveBeenCalledWith(expect.objectContaining({ size: 4 }));
	});

	it("checkpoints parts in order and only removes recovery data after confirmed save", async () => {
		const order: string[] = [];
		const track = { stop: vi.fn() };
		const recorder = new TestRecorder();
		const session = new RecordingSession({
			requestStream: async () => ({ getTracks: () => [track] }),
			createRecorder: () => recorder,
			createSessionId: () => "session-1",
			onCheckpointStart: async () => void order.push("begin"),
			onCheckpointPart: async ({ index }) => void order.push(`part:${index}`),
			onCheckpointReady: async () => void order.push("ready"),
			onSave: async () => void order.push("save"),
			onSaveConfirmed: async () => void order.push("remove"),
		});
		await session.start({ itemId: "item-1" });
		recorder.emit(2);
		recorder.emit(3);
		session.stop();
		recorder.finish();
		await vi.waitFor(() => expect(session.currentPhase()).toBe("idle"));
		expect(order).toEqual(["begin", "part:0", "part:1", "ready", "save", "remove"]);
	});

	it("keeps durable recovery data when the final save fails", async () => {
		const remove = vi.fn(async () => undefined);
		const onError = vi.fn();
		const recorder = new TestRecorder();
		const session = new RecordingSession({
			requestStream: async () => ({ getTracks: () => [] }),
			createRecorder: () => recorder,
			createSessionId: () => "session-1",
			onCheckpointStart: async () => undefined,
			onCheckpointPart: async () => undefined,
			onCheckpointReady: async () => undefined,
			onSave: async () => {
				throw new Error("disk unavailable");
			},
			onSaveConfirmed: remove,
			onError,
		});
		await session.start({ itemId: "item-1" });
		recorder.emit(2);
		session.stop();
		recorder.finish();
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
		expect(remove).not.toHaveBeenCalled();
	});
});
