import type { QueueItem } from "./types";

export type RecordingTargetContext = {
	itemId: string;
	path: string;
	title: string;
};

/** Resolves at save time so Vault renames queued before stop are observed. */
export function resolveRecordingTarget(
	context: RecordingTargetContext,
	queue: readonly QueueItem[],
): { path: string; title: string } {
	const current = queue.find((item) => item.id === context.itemId);
	return current ? { path: current.path, title: current.title } : context;
}
