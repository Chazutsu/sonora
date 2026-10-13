import type { QueueItem } from "./types";

export type QueuePlacement = "before" | "after";
export type QueueMoveDirection = "up" | "down";

type QueueState = { queue: QueueItem[] };

/** Reorders by stable IDs. Invalid and no-op requests preserve the original array. */
export function reorderQueueById(
	queue: readonly QueueItem[],
	sourceId: string,
	targetId: string,
	placement: QueuePlacement,
): QueueItem[] {
	if (sourceId === targetId) return queue as QueueItem[];
	const source = queue.find((item) => item.id === sourceId);
	if (!source || !queue.some((item) => item.id === targetId)) return queue as QueueItem[];
	const reordered = queue.filter((item) => item.id !== sourceId);
	const targetIndex = reordered.findIndex((item) => item.id === targetId);
	const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
	reordered.splice(insertionIndex, 0, source);
	return reordered.every((item, index) => item.id === queue[index]?.id)
		? (queue as QueueItem[])
		: reordered;
}

/** Moves against the currently visible order without disturbing hidden items unnecessarily. */
export function moveQueueItemAmongVisibleIds(
	queue: readonly QueueItem[],
	visibleIds: readonly string[],
	sourceId: string,
	direction: QueueMoveDirection,
): QueueItem[] {
	const sourceIndex = visibleIds.indexOf(sourceId);
	const targetId = direction === "up" ? visibleIds[sourceIndex - 1] : visibleIds[sourceIndex + 1];
	if (sourceIndex < 0 || !targetId) return queue as QueueItem[];
	return reorderQueueById(queue, sourceId, targetId, direction === "up" ? "before" : "after");
}

export async function reorderQueueDurably(
	state: QueueState,
	nextQueue: QueueItem[],
	persistCritical: () => Promise<boolean>,
	persistRollback: () => Promise<void>,
): Promise<boolean> {
	if (nextQueue === state.queue) return false;
	const previousQueue = state.queue;
	state.queue = nextQueue;
	if (await persistCritical()) return true;
	state.queue =
		state.queue === nextQueue
			? previousQueue
			: restorePreviousOrderWithoutClobberingConcurrentChanges(state.queue, previousQueue);
	await persistRollback();
	return false;
}

function restorePreviousOrderWithoutClobberingConcurrentChanges(
	current: readonly QueueItem[],
	previous: readonly QueueItem[],
): QueueItem[] {
	const previousIds = new Set(previous.map(({ id }) => id));
	const currentById = new Map(current.map((item) => [item.id, item]));
	const restoredSurvivors = previous.flatMap((item) => {
		const currentItem = currentById.get(item.id);
		return currentItem ? [currentItem] : [];
	});
	let survivorIndex = 0;
	return current.map((item) =>
		previousIds.has(item.id) ? (restoredSurvivors[survivorIndex++] ?? item) : item,
	);
}
