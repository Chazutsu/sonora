import type { QueueItem } from "./types";

type ReadonlyQueueItem = Omit<Readonly<QueueItem>, "chapters"> & {
	readonly chapters: readonly Readonly<QueueItem["chapters"][number]>[];
};

export function continueListening<Item extends ReadonlyQueueItem>(
	queue: readonly Item[],
	limit = 4,
): Item[] {
	return queue
		.filter((item) => !item.completed && !item.unavailable && item.lastPlayedAt !== undefined)
		.toSorted((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0))
		.slice(0, Math.max(0, limit));
}

export type QueueSections<Item extends ReadonlyQueueItem = QueueItem> = {
	current: Item | null;
	next: Item | null;
	following: Item[];
	history: Item[];
};

/** Derives the listening order without mutating the persisted manual queue. */
export function queueSections<Item extends ReadonlyQueueItem>(
	queue: readonly Item[],
	activeItemId: string | null,
	upNextItemId: string | null,
): QueueSections<Item> {
	const playable = queue.filter((item) => !item.unavailable && !item.loadError);
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
