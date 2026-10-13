import { describe, expect, it } from "vitest";
import { hydrateQueueItems } from "../src/queue-hydration";
import type { QueueItem } from "../src/types";

const item = (id: string): QueueItem => ({
	id,
	path: `${id}.md`,
	title: id,
	chapters: [],
	chapterIndex: 0,
	completed: false,
	addedAt: 0,
});

describe("hydrateQueueItems", () => {
	it("contains a first-item read failure and continues hydrating later items", async () => {
		const items = [item("a"), item("b"), item("c")];
		const visited: string[] = [];
		const result = await hydrateQueueItems(
			items,
			(path) => ({ path }),
			async (current) => {
				visited.push(current.id);
				if (current.id === "a") throw new Error("iCloud placeholder unavailable");
				current.chapters = [{ heading: current.id, level: 1, text: "ready" }];
				current.unavailable = false;
			},
		);
		expect(visited).toEqual(["a", "b", "c"]);
		expect(result).toEqual({ loaded: 2, failed: 1 });
		expect(items[0]).toMatchObject({ unavailable: true, loadError: true });
		expect(items[1]).toMatchObject({ unavailable: false, loadError: false });
	});

	it("contains a middle failure and clears its error on retry", async () => {
		const items = [item("a"), item("b"), item("c")];
		let fail = true;
		const update = async (current: QueueItem) => {
			if (current.id === "b" && fail) throw new Error("temporary read failure");
			current.chapters = [{ heading: current.id, level: 1, text: "ready" }];
			current.unavailable = false;
		};
		await hydrateQueueItems(items, (path) => ({ path }), update);
		expect(items[2]?.chapters).toHaveLength(1);
		expect(items[1]?.loadError).toBe(true);
		fail = false;
		await hydrateQueueItems(items, (path) => ({ path }), update);
		expect(items[1]).toMatchObject({ unavailable: false, loadError: false });
		expect(items[1]?.chapters).toHaveLength(1);
	});
});
