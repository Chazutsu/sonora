import type { QueueItem } from "./types";

export type QueueHydrationResult = {
	loaded: number;
	failed: number;
};

/** Hydrates every item independently so one unreadable note cannot block the queue. */
export async function hydrateQueueItems<File extends { path: string }>(
	items: QueueItem[],
	resolve: (path: string) => File | null,
	update: (item: QueueItem, file: File) => Promise<void>,
): Promise<QueueHydrationResult> {
	let loaded = 0;
	let failed = 0;
	for (const item of items) {
		const file = resolve(item.path);
		if (!file) {
			item.unavailable = true;
			item.loadError = false;
			continue;
		}
		item.path = file.path;
		try {
			await update(item, file);
			item.loadError = false;
			loaded += 1;
		} catch {
			item.unavailable = true;
			item.loadError = true;
			failed += 1;
		}
	}
	return { loaded, failed };
}
