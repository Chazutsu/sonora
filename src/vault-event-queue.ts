export interface VaultEventDescriptor {
	readonly type: string;
	readonly path: string;
}

export interface VaultEventFailure {
	readonly event: VaultEventDescriptor;
	readonly sequence: number;
	readonly error: unknown;
}

export interface VaultEventContext {
	readonly sequence: number;
	readonly event: VaultEventDescriptor;
}

export interface VaultEventQueueOptions {
	onError?(failure: VaultEventFailure): void;
	/**
	 * Called once per busy period when accepted work grows beyond the soft
	 * limit. Work is deliberately retained: dropping distinct paths could leave
	 * the listening queue stale until the next Vault event.
	 */
	onPressure?(pending: number): void;
	pressureThreshold?: number;
}

interface PendingEntry {
	context: VaultEventContext;
	operation: (context: VaultEventContext) => void | Promise<void>;
	started: boolean;
	latestKey?: string;
}

/**
 * Serializes asynchronous Vault callbacks in arrival order. `enqueue` is safe
 * to call from Obsidian's synchronous event handlers: failures are reported
 * through `onError` and never become unhandled promise rejections.
 */
export class VaultEventQueue {
	private tail: Promise<void> = Promise.resolve();
	private nextSequence = 0;
	private accepting = true;
	private discardPending = false;
	private pendingCount = 0;
	private pressureReported = false;
	private readonly pendingLatest = new Map<string, PendingEntry>();

	constructor(private readonly options: Readonly<VaultEventQueueOptions> = {}) {}

	enqueue(
		event: VaultEventDescriptor,
		operation: (context: VaultEventContext) => void | Promise<void>,
	): boolean {
		// A non-coalesced event is an ordering barrier. In particular, modifies
		// must never merge across a rename or delete.
		this.pendingLatest.clear();
		return this.append(event, operation);
	}

	/**
	 * Replaces an unstarted operation with the newest operation for `key`.
	 * Running work is never interrupted, and normal `enqueue` calls form
	 * barriers, so event ordering remains exact around rename/delete.
	 */
	enqueueLatest(
		key: string,
		event: VaultEventDescriptor,
		operation: (context: VaultEventContext) => void | Promise<void>,
	): boolean {
		if (!this.accepting) return false;
		const existing = this.pendingLatest.get(key);
		const context = this.createContext(event);
		if (existing && !existing.started) {
			existing.context = context;
			existing.operation = operation;
			return true;
		}
		return this.append(event, operation, key, context);
	}

	whenIdle(): Promise<void> {
		return this.tail;
	}

	close(options: Readonly<{ discardPending?: boolean }> = {}): Promise<void> {
		this.accepting = false;
		this.discardPending = options.discardPending === true;
		return this.whenIdle();
	}

	isAccepting(): boolean {
		return this.accepting;
	}

	pending(): number {
		return this.pendingCount;
	}

	private append(
		event: VaultEventDescriptor,
		operation: (context: VaultEventContext) => void | Promise<void>,
		latestKey?: string,
		context = this.createContext(event),
	): boolean {
		if (!this.accepting) return false;
		const entry: PendingEntry = { context, operation, started: false, latestKey };
		if (latestKey !== undefined && latestKey !== "") this.pendingLatest.set(latestKey, entry);
		this.pendingCount += 1;
		this.reportPressure();
		this.tail = this.tail.then(() => this.run(entry));
		return true;
	}

	private createContext(event: VaultEventDescriptor): VaultEventContext {
		return Object.freeze({
			sequence: ++this.nextSequence,
			event: Object.freeze({ ...event }),
		});
	}

	private async run(entry: PendingEntry): Promise<void> {
		entry.started = true;
		if (
			entry.latestKey !== undefined &&
			entry.latestKey !== "" &&
			this.pendingLatest.get(entry.latestKey) === entry
		) {
			this.pendingLatest.delete(entry.latestKey);
		}
		try {
			if (this.discardPending) return;
			await entry.operation(entry.context);
		} catch (error) {
			try {
				this.options.onError?.({
					event: entry.context.event,
					sequence: entry.context.sequence,
					error,
				});
			} catch {
				// Diagnostics must not poison the queue or suppress later events.
			}
		} finally {
			this.pendingCount -= 1;
			if (this.pendingCount === 0) this.pressureReported = false;
		}
	}

	private reportPressure(): void {
		const threshold = Math.max(1, this.options.pressureThreshold ?? 256);
		if (this.pressureReported || this.pendingCount <= threshold) return;
		this.pressureReported = true;
		try {
			this.options.onPressure?.(this.pendingCount);
		} catch {
			// Diagnostics must not poison the queue.
		}
	}
}
