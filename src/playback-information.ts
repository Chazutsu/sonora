import type { QueueItem } from "./types";

export function continueListening(queue: readonly QueueItem[], limit = 4): QueueItem[] {
	return queue
		.filter((item) => !item.completed && !item.unavailable && item.lastPlayedAt !== undefined)
		.toSorted((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0))
		.slice(0, Math.max(0, limit));
}

export type QueueSections = {
	current: QueueItem | null;
	next: QueueItem | null;
	following: QueueItem[];
	history: QueueItem[];
};

/** Derives the listening order without mutating the persisted manual queue. */
export function queueSections(
	queue: readonly QueueItem[],
	activeItemId: string | null,
	upNextItemId: string | null,
): QueueSections {
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
