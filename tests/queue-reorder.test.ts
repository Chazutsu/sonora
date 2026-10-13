import { describe, expect, it, vi } from "vitest";
import {
	moveQueueItemAmongVisibleIds,
	reorderQueueById,
	reorderQueueDurably,
} from "../src/queue-reorder";
import type { QueueItem } from "../src/types";
import { deserializeData, serializeData } from "../src/persistence";
import { DEFAULT_SETTINGS } from "../src/types";

const item = (id: string, completed = false): QueueItem => ({
	id,
	path: `${id}.md`,
	title: id,
	chapters: [{ heading: id, level: 1, text: id }],
	chapterIndex: 0,
	completed,
	addedAt: 1,
	kind: "note",
});

describe("queue reorder", () => {
	it("reorders active and completed items solely by stable IDs", () => {
		const queue = [item("active"), item("done", true), item("next")];
		expect(reorderQueueById(queue, "done", "active", "before").map(({ id }) => id)).toEqual([
			"done",
			"active",
			"next",
		]);
	});

	it("moves between filtered neighbours while retaining hidden items", () => {
		const queue = [item("visible-a"), item("hidden"), item("visible-b"), item("visible-c")];
		const moved = moveQueueItemAmongVisibleIds(
			queue,
			["visible-a", "visible-b", "visible-c"],
			"visible-c",
			"up",
		);
		expect(moved.map(({ id }) => id)).toEqual(["visible-a", "hidden", "visible-c", "visible-b"]);
	});

	it("returns the same array for invalid and boundary moves", () => {
		const queue = [item("a"), item("b")];
		expect(moveQueueItemAmongVisibleIds(queue, ["a", "b"], "a", "up")).toBe(queue);
		expect(reorderQueueById(queue, "missing", "b", "after")).toBe(queue);
	});

	it("rolls back the exact order when durable persistence fails", async () => {
		const original = [item("a"), item("b")];
		const state = { queue: original };
		const rollback = vi.fn().mockResolvedValue(undefined);
		await expect(
			reorderQueueDurably(
				state,
				reorderQueueById(original, "b", "a", "before"),
				vi.fn().mockResolvedValue(false),
				rollback,
			),
		).resolves.toBe(false);
		expect(state.queue).toBe(original);
		expect(rollback).toHaveBeenCalledOnce();
	});

	it("rolls back ordering without resurrecting removals or dropping concurrent additions", async () => {
		const original = [item("a"), item("b"), item("c")];
		const state = { queue: original };
		const next = reorderQueueById(original, "c", "a", "before");
		const saved = await reorderQueueDurably(
			state,
			next,
			async () => {
				state.queue = [...state.queue.filter(({ id }) => id !== "b"), item("added")];
				return false;
			},
			vi.fn().mockResolvedValue(undefined),
		);

		expect(saved).toBe(false);
		expect(state.queue.map(({ id }) => id)).toEqual(["a", "c", "added"]);
	});

	it("keeps the reordered array after a durable write", async () => {
		const state = { queue: [item("a"), item("b")] };
		const next = reorderQueueById(state.queue, "b", "a", "before");
		await expect(
			reorderQueueDurably(state, next, vi.fn().mockResolvedValue(true), vi.fn()),
		).resolves.toBe(true);
		expect(state.queue).toBe(next);
	});

	it("restores manual order and Up Next identity after serialization and restart", () => {
		const queue = reorderQueueById(
			[item("active"), item("up-next"), item("done", true)],
			"done",
			"active",
			"before",
		);
		const stored = serializeData({
			settings: DEFAULT_SETTINGS,
			queue,
			activeItemId: "active",
			upNextItemId: "up-next",
			pendingVoiceMemoLinks: [],
		});
		const restarted = deserializeData(stored);
		expect(restarted.queue.map(({ id }) => id)).toEqual(["done", "active", "up-next"]);
		expect(restarted.activeItemId).toBe("active");
		expect(restarted.upNextItemId).toBe("up-next");
	});
});
