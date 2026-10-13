import type { QueueItem } from "./types";

export type QueueHydrationResult = {
	loaded: number;
	failed: number;
};

/** Hydrates every item independently so one unreadable note cannot block the queue. */
export async function hydrateQueueItems<File extends { path: string }>(
	// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- Hydration records resolved paths and availability directly on every queued item.
	items: QueueItem[],
	resolve: (path: string) => File | null,
	update: (
		// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- The updater populates mutable queue-item metadata from the resolved file.
		item: QueueItem,
		file: File,
	) => Promise<void>,
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
