export interface CurrentFileRefresh<T> {
	status: "current";
	path: string;
	generation: number;
	value: T;
}

export interface StaleFileRefresh {
	status: "stale";
	path: string;
	generation: number;
}

export type FileRefreshResult<T> = CurrentFileRefresh<T> | StaleFileRefresh;
export type FileRefreshConsumer<T> = (
	refresh: Readonly<CurrentFileRefresh<T>>,
) => void | Promise<void>;

/**
 * Coordinates asynchronous reads for a path without allowing an older read to
 * overwrite a newer Vault event. A delete/rename can invalidate an in-flight
 * read even when it does not start a replacement read.
 */
export class FileRefreshCoordinator<T> {
	private readonly generations = new Map<string, number>();
	private nextGeneration = 0;

	constructor(
		private readonly read: (path: string) => Promise<string>,
		private readonly parse: (source: string, path: string) => T | Promise<T>,
	) {}

	async refresh(path: string): Promise<FileRefreshResult<T>> {
		const generation = this.bump(path);

		try {
			const source = await this.read(path);
			if (!this.isCurrent(path, generation)) return this.stale(path, generation);

			const value = await this.parse(source, path);
			if (!this.isCurrent(path, generation)) return this.stale(path, generation);

			return { status: "current", path, generation, value };
		} catch (error) {
			// A superseded read may fail after a rename or delete. That failure is no
			// longer actionable and must not replace the newer event with an error.
			if (!this.isCurrent(path, generation)) return this.stale(path, generation);
			throw error;
		}
	}

	async refreshAndConsume(
		path: string,
		...consumers: readonly FileRefreshConsumer<T>[]
	): Promise<FileRefreshResult<T>> {
		const result = await this.refresh(path);
		if (result.status === "stale") return result;

		for (const consumer of consumers) {
			if (!this.isCurrent(path, result.generation)) return this.stale(path, result.generation);
			await consumer(result);
		}

		return this.isCurrent(path, result.generation) ? result : this.stale(path, result.generation);
	}

	invalidate(path: string): number {
		return this.bump(path);
	}

	currentGeneration(path: string): number {
		return this.generations.get(path) ?? 0;
	}

	forget(path: string): void {
		this.generations.delete(path);
	}

	forgetIfCurrent(path: string, generation: number): boolean {
		if (!this.isCurrent(path, generation)) return false;
		this.generations.delete(path);
		return true;
	}

	private bump(path: string): number {
		const generation = ++this.nextGeneration;
		this.generations.set(path, generation);
		return generation;
	}

	private isCurrent(path: string, generation: number): boolean {
		return this.currentGeneration(path) === generation;
	}

	private stale(path: string, generation: number): StaleFileRefresh {
		return { status: "stale", path, generation };
	}
}
