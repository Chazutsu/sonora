import { nextUnfinishedQueueItem } from "./player";
import type { QueueItem, ReadonlyQueueItem } from "./types";

export type ListeningAdvanceResult =
	| { kind: "next-chapter" }
	| { kind: "next-item"; item: QueueItem }
	| { kind: "queue-ended" }
	| { kind: "save-failed" };

type ListeningState = {
	queue: QueueItem[];
	activeItemId: string | null;
	upNextItemId?: string | null;
};

export async function setUpNextDurably(
	state: ListeningState,
	id: string | null,
	persistCritical: () => Promise<boolean>,
	persistRollback: () => Promise<void>,
): Promise<boolean> {
	if (
		id !== null &&
		(id === state.activeItemId ||
			!state.queue.some(
				(candidate: ReadonlyQueueItem) => candidate.id === id && !candidate.completed,
			))
	)
		return false;
	if ((state.upNextItemId ?? null) === id) return true;
	const previous = state.upNextItemId ?? null;
	state.upNextItemId = id;
	if (await persistCritical()) return true;
	state.upNextItemId = previous;
	await persistRollback();
	return false;
}

/**
 * Applies one listening transition transactionally. If the durable write
 * fails, in-memory state is restored and the rollback snapshot supersedes the
 * failed transition retained by PersistenceQueue.
 */
export async function advanceListeningAfterEnd(
	state: ListeningState,
	item: QueueItem,
	persistCritical: () => Promise<boolean>,
	persistRollback: () => Promise<void>,
): Promise<ListeningAdvanceResult> {
	const previousChapterIndex = item.chapterIndex;
	const previousCompleted = item.completed;
	const previousActiveItemId = state.activeItemId;
	const previousUpNextItemId = state.upNextItemId;
	let result: ListeningAdvanceResult;

	if (item.chapterIndex < item.chapters.length - 1) {
		item.chapterIndex += 1;
		result = { kind: "next-chapter" };
	} else {
		item.completed = true;
		const requestedNext = state.queue.find(
			(candidate: ReadonlyQueueItem) =>
				candidate.id === state.upNextItemId && candidate.id !== item.id && !candidate.completed,
		);
		const nextItem = requestedNext ?? nextUnfinishedQueueItem(state.queue, item.id);
		state.upNextItemId = null;
		if (nextItem) {
			state.activeItemId = nextItem.id;
			result = { kind: "next-item", item: nextItem };
		} else {
			result = { kind: "queue-ended" };
		}
	}

	if (await persistCritical()) return result;

	item.chapterIndex = previousChapterIndex;
	item.completed = previousCompleted;
	state.activeItemId = previousActiveItemId;
	state.upNextItemId = previousUpNextItemId;
	await persistRollback();
	return { kind: "save-failed" };
}
