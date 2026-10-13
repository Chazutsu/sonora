export interface PersistenceQueueOptions {
	onError?: (error: unknown) => void;
}

/**
 * Serializes persistence without letting stale intermediate snapshots build up.
 * A rejected write is retained as dirty state and can be retried explicitly.
 */
export class PersistenceQueue<T> {
	private latest: { snapshot: T; revision: number } | undefined;
	private nextRevision = 0;
	private criticalWaiters = new Map<number, (durable: boolean) => void>();
	private running = false;
	private disposed = false;
	private disposeRequested = false;
	private dirtyState = false;
	private errorReported = false;
	private idlePromise: Promise<void> = Promise.resolve();
	private resolveIdle: (() => void) | null = null;

	constructor(
		private readonly write: (snapshot: T) => Promise<void>,
		private readonly options: PersistenceQueueOptions = {},
	) {}

	get dirty(): boolean {
		return this.dirtyState;
	}

	get isRunning(): boolean {
		return this.running;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	save(snapshot: T): Promise<void> {
		if (this.disposed || this.disposeRequested) return Promise.resolve();
		this.enqueue(snapshot);
		this.dirtyState = true;
		this.ensureIdlePromise();
		this.start();
		return this.idlePromise;
	}

	/**
	 * Saves a state transition and reports whether it became durable. Normal
	 * saves deliberately resolve after a failed write so background callers do
	 * not create unhandled rejections; playback transitions need the stronger
	 * result before they continue to the next chapter or queue item.
	 */
	async saveCritical(snapshot: T): Promise<boolean> {
		if (this.disposed || this.disposeRequested) return false;
		const revision = this.enqueue(snapshot);
		const result = new Promise<boolean>((resolve) => {
			this.criticalWaiters.set(revision, resolve);
		});
		this.dirtyState = true;
		this.ensureIdlePromise();
		this.start();
		return result;
	}

	retry(): Promise<void> {
		if (this.disposed || this.disposeRequested || !this.dirtyState || this.latest === undefined) {
			return Promise.resolve();
		}
		this.ensureIdlePromise();
		this.start();
		return this.idlePromise;
	}

	whenIdle(): Promise<void> {
		return this.idlePromise;
	}

	dispose(): void {
		if (this.disposed || this.disposeRequested) return;
		this.disposeRequested = true;
		if (!this.running) this.resolveAllCritical(false);
		if (this.running) return;
		this.disposed = true;
		this.finishIdle();
	}

	private ensureIdlePromise(): void {
		if (this.resolveIdle) return;
		this.idlePromise = new Promise((resolve) => {
			this.resolveIdle = resolve;
		});
	}

	private start(): void {
		if (this.running || this.disposed) return;
		this.running = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		while (!this.disposed && this.latest !== undefined) {
			const entry = this.latest;
			this.latest = undefined;
			try {
				await this.write(entry.snapshot);
				this.resolveCritical(entry.revision, true);
				this.errorReported = false;
				if (this.latest === undefined) this.dirtyState = false;
			} catch (error) {
				this.resolveCritical(entry.revision, false);
				// A newer desired state supersedes the failed snapshot and must still be
				// attempted. Otherwise retain the failed state for an explicit retry.
				const hasNewerSnapshot = this.latest !== undefined;
				if (!hasNewerSnapshot)
					this.latest = {
						snapshot: entry.snapshot,
						revision: ++this.nextRevision,
					};
				this.dirtyState = true;
				if (!hasNewerSnapshot && !this.disposeRequested && !this.disposed && !this.errorReported) {
					this.errorReported = true;
					try {
						this.options.onError?.(error);
					} catch {
						// Error reporting must never create an unhandled rejection.
					}
				}
				if (!hasNewerSnapshot) break;
			}
		}

		this.running = false;
		if (this.disposeRequested) {
			this.disposed = true;
			this.resolveAllCritical(false);
		}
		this.finishIdle();
	}

	private enqueue(snapshot: T): number {
		if (this.latest) this.resolveCritical(this.latest.revision, false);
		const revision = ++this.nextRevision;
		this.latest = { snapshot, revision };
		return revision;
	}

	private resolveCritical(revision: number, durable: boolean): void {
		const resolve = this.criticalWaiters.get(revision);
		if (!resolve) return;
		this.criticalWaiters.delete(revision);
		resolve(durable);
	}

	private resolveAllCritical(durable: boolean): void {
		for (const resolve of this.criticalWaiters.values()) resolve(durable);
		this.criticalWaiters.clear();
	}

	private finishIdle(): void {
		const resolve = this.resolveIdle;
		this.resolveIdle = null;
		resolve?.();
	}
}
