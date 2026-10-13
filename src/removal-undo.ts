import { sameVaultPath } from "./persistence";
import type { QueueItem } from "./types";

export const DEFAULT_REMOVAL_UNDO_DURATION_MS = 30_000;

export type RemovalUndoEntry = {
	id: string;
	item: QueueItem;
	index: number;
	wasActive: boolean;
	fallbackActiveItemId: string | null;
	returnFocusItemId: string | null;
	expiresAt: number;
};

export class RemovalUndoHistory {
	private entries: RemovalUndoEntry[] = [];

	constructor(
		private readonly durationMs: number,
		private readonly now: () => number = Date.now,
	) {}

	record(
		item: QueueItem,
		index: number,
		wasActive: boolean,
		fallbackActiveItemId: string | null,
		returnFocusItemId: string | null = null,
	): RemovalUndoEntry {
		this.prune();
		const entry: RemovalUndoEntry = {
			id: item.id,
			item: cloneQueueItem(item),
			index,
			wasActive,
			fallbackActiveItemId,
			returnFocusItemId,
			expiresAt: this.now() + this.durationMs,
		};
		this.entries.push(entry);
		return entry;
	}

	latest(): RemovalUndoEntry | null {
		this.prune();
		return this.entries.at(-1) ?? null;
	}

	take(id: string): RemovalUndoEntry | null {
		this.prune();
		const index = this.entries.findLastIndex((entry) => entry.id === id);
		if (index < 0) return null;
		return this.entries.splice(index, 1)[0] ?? null;
	}

	nextExpiry(): number | null {
		this.prune();
		return this.entries.length ? Math.min(...this.entries.map((entry) => entry.expiresAt)) : null;
	}

	clear(): void {
		this.entries = [];
	}

	renamePath(oldPath: string, path: string, title: string): boolean {
		this.prune();
		let renamed = false;
		for (const entry of this.entries) {
			if (!sameVaultPath(entry.item.path, oldPath)) continue;
			entry.item.path = path;
			entry.item.title = title;
			renamed = true;
		}
		return renamed;
	}

	private prune(): void {
		const now = this.now();
		this.entries = this.entries.filter((entry) => entry.expiresAt > now);
	}
}

export function restoreRemovedItem(
	queue: readonly QueueItem[],
	entry: RemovalUndoEntry,
	refreshedItem: QueueItem,
): QueueItem[] | null {
	const conflicts = queue.some(
		(item) =>
			item.id === entry.item.id ||
			(sameVaultPath(item.path, entry.item.path) &&
				(item.kind ?? "note") === (entry.item.kind ?? "note")),
	);
	if (conflicts) return null;

	const restored = [...queue];
	restored.splice(Math.min(Math.max(0, entry.index), restored.length), 0, refreshedItem);
	return restored;
}

export function shouldRestoreRemovedAsActive(
	entry: RemovalUndoEntry,
	currentActiveItemId: string | null,
): boolean {
	return entry.wasActive && currentActiveItemId === entry.fallbackActiveItemId;
}

function cloneQueueItem(item: QueueItem): QueueItem {
	return { ...item, chapters: item.chapters.map((chapter) => ({ ...chapter })) };
}
