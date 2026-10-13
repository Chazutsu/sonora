import { describe, expect, it, vi } from "vitest";
import { advanceListeningAfterEnd, setUpNextDurably } from "../src/playback-transition";
import type { QueueItem } from "../src/types";

function item(id: string, chapterCount = 1): QueueItem {
	return {
		id,
		path: `${id}.md`,
		title: id,
		chapters: Array.from({ length: chapterCount }, (_, index) => ({
			heading: `Chapter ${index + 1}`,
			level: 1,
			text: "Text",
		})),
		chapterIndex: 0,
		completed: false,
		addedAt: 1,
		kind: "note",
	};
}

describe("advanceListeningAfterEnd", () => {
	it("rolls back a chapter advance when its critical iCloud save fails", async () => {
		const current = item("current", 2);
		const state = { queue: [current], activeItemId: current.id };
		const persistRollback = vi.fn().mockResolvedValue(undefined);

		const result = await advanceListeningAfterEnd(
			state,
			current,
			vi.fn().mockResolvedValue(false),
			persistRollback,
		);

		expect(result).toEqual({ kind: "save-failed" });
		expect(current.chapterIndex).toBe(0);
		expect(current.completed).toBe(false);
		expect(state.activeItemId).toBe("current");
		expect(persistRollback).toHaveBeenCalledOnce();
	});

	it("does not complete or switch items when the atomic transition cannot be saved", async () => {
		const current = item("current");
		const next = item("next");
		const state = { queue: [current, next], activeItemId: current.id };

		const result = await advanceListeningAfterEnd(
			state,
			current,
			vi.fn().mockResolvedValue(false),
			vi.fn().mockResolvedValue(undefined),
		);

		expect(result).toEqual({ kind: "save-failed" });
		expect(current.completed).toBe(false);
		expect(state.activeItemId).toBe("current");
	});

	it("commits completion and the next active item in one durable transition", async () => {
		const current = item("current");
		const next = item("next");
		const state = { queue: [current, next], activeItemId: current.id };
		const persistCritical = vi.fn(async () => {
			expect(current.completed).toBe(true);
			expect(state.activeItemId).toBe("next");
			return true;
		});

		const result = await advanceListeningAfterEnd(state, current, persistCritical, vi.fn());

		expect(result.kind).toBe("next-item");
		expect(persistCritical).toHaveBeenCalledOnce();
	});

	it("consumes an explicit Up Next item without reordering the queue", async () => {
		const current = item("current");
		const natural = item("natural");
		const requested = item("requested");
		const state = {
			queue: [current, natural, requested],
			activeItemId: current.id,
			upNextItemId: requested.id,
		};

		const result = await advanceListeningAfterEnd(
			state,
			current,
			vi.fn().mockResolvedValue(true),
			vi.fn(),
		);

		expect(result).toEqual({ kind: "next-item", item: requested });
		expect(state.queue.map((candidate) => candidate.id)).toEqual([
			"current",
			"natural",
			"requested",
		]);
		expect(state.upNextItemId).toBeNull();
	});

	it("restores Up Next when consuming it cannot be saved", async () => {
		const current = item("current");
		const requested = item("requested");
		const state = {
			queue: [current, requested],
			activeItemId: current.id,
			upNextItemId: requested.id,
		};

		await advanceListeningAfterEnd(
			state,
			current,
			vi.fn().mockResolvedValue(false),
			vi.fn().mockResolvedValue(undefined),
		);

		expect(state.activeItemId).toBe("current");
		expect(state.upNextItemId).toBe("requested");
	});
});

describe("setUpNextDurably", () => {
	it("rolls the choice back when its critical save fails", async () => {
		const current = item("current");
		const next = item("next");
		const state = { queue: [current, next], activeItemId: current.id, upNextItemId: null };
		const persistRollback = vi.fn().mockResolvedValue(undefined);

		const saved = await setUpNextDurably(
			state,
			next.id,
			vi.fn().mockResolvedValue(false),
			persistRollback,
		);

		expect(saved).toBe(false);
		expect(state.upNextItemId).toBeNull();
		expect(persistRollback).toHaveBeenCalledOnce();
	});
});
