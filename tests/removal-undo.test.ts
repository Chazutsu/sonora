import { describe, expect, it } from "vitest";
import {
	DEFAULT_REMOVAL_UNDO_DURATION_MS,
	RemovalUndoHistory,
	restoreRemovedItem,
	shouldRestoreRemovedAsActive,
} from "../src/removal-undo";
import type { QueueItem } from "../src/types";

const item = (id: string, path = `${id}.md`): QueueItem => ({
	id,
	path,
	title: id,
	chapters: [{ heading: id, level: 1, text: id }],
	chapterIndex: 0,
	completed: false,
	addedAt: 1,
	kind: "note",
});

describe("RemovalUndoHistory", () => {
	it("keeps the default undo window available for at least 30 seconds", () => {
		expect(DEFAULT_REMOVAL_UNDO_DURATION_MS).toBeGreaterThanOrEqual(30_000);
	});

	it("supports consecutive removals in last-removed-first order", () => {
		let now = 100;
		const history = new RemovalUndoHistory(1_000, () => now);
		history.record(item("first"), 0, true, "second");
		now += 10;
		history.record(item("second"), 0, true, null);

		expect(history.latest()?.id).toBe("second");
		expect(history.take("second")?.id).toBe("second");
		expect(history.latest()?.id).toBe("first");
	});

	it("does not return expired removals", () => {
		let now = 100;
		const history = new RemovalUndoHistory(1_000, () => now);
		history.record(item("first"), 0, true, null);

		now = 1_100;

		expect(history.latest()).toBeNull();
		expect(history.take("first")).toBeNull();
	});

	it("stores an immutable copy of the removed item", () => {
		const removed = item("first");
		const history = new RemovalUndoHistory(1_000, () => 100);
		history.record(removed, 0, true, null);

		removed.title = "changed";
		removed.chapters[0]!.text = "changed";

		expect(history.latest()?.item.title).toBe("first");
		expect(history.latest()?.item.chapters[0]?.text).toBe("first");
	});

	it("keeps the intended focus target for dismissal", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		history.record(item("first"), 0, true, "second", "second");

		expect(history.latest()?.returnFocusItemId).toBe("second");
	});

	it("follows a source rename while the item is waiting for undo", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		history.record(item("first", "Notes/Original.md"), 0, true, null);

		expect(history.renamePath("Notes/Original.md", "Archive/Renamed.md", "Renamed")).toBe(true);
		expect(history.latest()?.item).toMatchObject({
			path: "Archive/Renamed.md",
			title: "Renamed",
		});
	});

	it("does not rewrite unrelated undo tombstones", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		history.record(item("first", "Notes/Original.md"), 0, true, null);

		expect(history.renamePath("Notes/Other.md", "Archive/Other.md", "Other")).toBe(false);
		expect(history.latest()?.item.path).toBe("Notes/Original.md");
	});
});

describe("restoreRemovedItem", () => {
	it("restores at the original bounded position", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		const entry = history.record(item("removed"), 1, false, "first");

		const refreshed = { ...item("removed"), title: "Fresh source title" };
		const restored = restoreRemovedItem([item("first"), item("last")], entry, refreshed);

		expect(restored?.map(({ id }) => id)).toEqual(["first", "removed", "last"]);
		expect(restored?.[1]?.title).toBe("Fresh source title");
	});

	it("restores into the recorded slot after the remaining queue was reordered", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		const entry = history.record(item("removed"), 1, false, "first");
		const restored = restoreRemovedItem([item("last"), item("first")], entry, item("removed"));

		expect(restored?.map(({ id }) => id)).toEqual(["last", "removed", "first"]);
	});

	it("refuses restoration when the id was reused", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		const entry = history.record(item("removed"), 0, false, null);

		expect(restoreRemovedItem([item("removed", "new.md")], entry, item("removed"))).toBeNull();
	});

	it("refuses restoration when the same source and kind was added again", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		const entry = history.record(item("removed", "Folder/Note.md"), 0, false, null);

		expect(
			restoreRemovedItem(
				[item("replacement", "Folder/Note.md")],
				entry,
				item("removed", "Folder/Note.md"),
			),
		).toBeNull();
	});

	it("restores active state only while the deletion fallback is still selected", () => {
		const history = new RemovalUndoHistory(1_000, () => 100);
		const entry = history.record(item("removed"), 0, true, "fallback");

		expect(shouldRestoreRemovedAsActive(entry, "fallback")).toBe(true);
		expect(shouldRestoreRemovedAsActive(entry, "user-selection")).toBe(false);
	});
});
