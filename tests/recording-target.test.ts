import { describe, expect, it } from "vitest";
import { resolveRecordingTarget } from "../src/recording-target";
import type { QueueItem } from "../src/types";
import { VaultEventQueue } from "../src/vault-event-queue";

const queued = (): QueueItem => ({
	id: "item-a",
	path: "A.md",
	title: "A",
	chapters: [],
	chapterIndex: 0,
	completed: false,
	addedAt: 0,
});
const context = { itemId: "item-a", path: "A.md", title: "A" };

describe("recording target ordering", () => {
	it("uses the latest item path when rename is queued before recording stop", async () => {
		const items = [queued()];
		const queue = new VaultEventQueue();
		let releaseRename!: () => void;
		const renameReady = new Promise<void>((resolve) => {
			releaseRename = resolve;
		});
		let saved: ReturnType<typeof resolveRecordingTarget> | null = null;
		queue.enqueue({ type: "rename", path: "B.md" }, async () => {
			await renameReady;
			items[0]!.path = "B.md";
			items[0]!.title = "B";
		});
		queue.enqueue({ type: "recording-save", path: "A.md" }, () => {
			saved = resolveRecordingTarget(context, items);
		});
		await Promise.resolve();
		expect(saved).toBeNull();
		releaseRename();
		await queue.whenIdle();
		expect(saved).toEqual({ path: "B.md", title: "B" });
	});

	it("retains the deleted source path so save can journal a recoverable link intent", async () => {
		const items = [queued()];
		const queue = new VaultEventQueue();
		let saved: ReturnType<typeof resolveRecordingTarget> | null = null;
		queue.enqueue({ type: "delete", path: "A.md" }, () => {
			items[0]!.unavailable = true;
			items[0]!.chapters = [];
		});
		queue.enqueue({ type: "recording-save", path: "A.md" }, () => {
			saved = resolveRecordingTarget(context, items);
		});
		await queue.whenIdle();
		expect(saved).toEqual({ path: "A.md", title: "A" });
	});

	it("honors arrival order when stop is queued before rename", async () => {
		const items = [queued()];
		const queue = new VaultEventQueue();
		const saved: Array<ReturnType<typeof resolveRecordingTarget>> = [];
		queue.enqueue({ type: "recording-save", path: "A.md" }, () => {
			saved.push(resolveRecordingTarget(context, items));
		});
		queue.enqueue({ type: "rename", path: "B.md" }, () => {
			items[0]!.path = "B.md";
			items[0]!.title = "B";
		});
		await queue.whenIdle();
		expect(saved).toEqual([{ path: "A.md", title: "A" }]);
		expect(items[0]).toMatchObject({ path: "B.md", title: "B" });
	});
});
