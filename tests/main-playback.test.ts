import { describe, expect, it, vi } from "vitest";
import SonoraPlugin from "../src/main";
import { PersistenceQueue } from "../src/persistence-queue";
import { DEFAULT_SETTINGS, type QueueItem, type StoredSonoraData } from "../src/types";

function queueItem(id: string): QueueItem {
	return {
		id,
		path: `${id}.md`,
		title: id,
		chapters: [{ heading: "Chapter", level: 1, text: "Text" }],
		chapterIndex: 0,
		completed: false,
		addedAt: 1,
		kind: "note",
	};
}

describe("SonoraPlugin playback persistence", () => {
	it("keeps the current item active when advanceAfterEnd cannot save and remains retryable", async () => {
		const current = queueItem("current");
		const next = queueItem("next");
		const write = vi.fn().mockRejectedValue(new Error("iCloud unavailable"));
		const persistenceQueue = new PersistenceQueue<StoredSonoraData>(write);
		const plugin = Object.create(SonoraPlugin.prototype) as SonoraPlugin & Record<string, unknown>;
		Object.assign(plugin, {
			data: {
				settings: DEFAULT_SETTINGS,
				queue: [current, next],
				activeItemId: current.id,
				pendingVoiceMemoLinks: [],
			},
			transportGeneration: 1,
			recording: false,
			playbackError: null,
			persistenceQueue,
			refresh: vi.fn(),
			playCurrent: vi.fn(),
			updateMediaSessionState: vi.fn(),
		});

		const advanceAfterEnd = Reflect.get(plugin, "advanceAfterEnd").bind(plugin) as (
			generation: number,
		) => Promise<void>;
		await advanceAfterEnd(1);

		expect(current.completed).toBe(false);
		expect(plugin.data.activeItemId).toBe("current");
		expect(Reflect.get(plugin, "playCurrent")).not.toHaveBeenCalled();
		expect(plugin.playbackError).toContain("Retry saving progress");
		expect(persistenceQueue.dirty).toBe(true);

		write.mockResolvedValueOnce(undefined);
		await persistenceQueue.retry();
		expect(persistenceQueue.dirty).toBe(false);
	});
});
