import type { ReadonlyQueueItem } from "./types";

export function continueListening<Item extends ReadonlyQueueItem>(
	queue: readonly Item[],
	limit = 4,
): Item[] {
	return queue
		.filter(
			(item) =>
				item.completed !== true && item.unavailable !== true && item.lastPlayedAt !== undefined,
		)
		.toSorted((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0))
		.slice(0, Math.max(0, limit));
}

export type QueueSections<Item extends ReadonlyQueueItem = ReadonlyQueueItem> = {
	readonly current: Item | null;
	readonly next: Item | null;
	readonly following: readonly Item[];
	readonly history: readonly Item[];
};

/** Derives the listening order without mutating the persisted manual queue. */
export function queueSections<Item extends ReadonlyQueueItem>(
	queue: readonly Item[],
	activeItemId: string | null,
	upNextItemId: string | null,
): QueueSections<Item> {
	const playable = queue.filter((item) => item.unavailable !== true && item.loadError !== true);
	const current = playable.find((item) => item.id === activeItemId) ?? null;
	const unfinished = playable.filter((item) => !item.completed && item.id !== current?.id);
	const explicitNext = unfinished.find((item) => item.id === upNextItemId) ?? null;
	const currentIndex = current ? playable.findIndex((item) => item.id === current.id) : -1;
	const naturalNext =
		unfinished.find(
			(item) => playable.findIndex((candidate) => candidate.id === item.id) > currentIndex,
		) ??
		unfinished[0] ??
		null;
	const next = explicitNext ?? naturalNext;
	return {
		current,
		next,
		following: unfinished.filter((item) => item.id !== next?.id),
		history: playable
			.filter((item) => item.completed)
			.toSorted((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)),
	};
}
