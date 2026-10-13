import { describe, expect, it, vi } from "vitest";
import { enqueueVaultModify, enqueueVaultRename } from "../src/vault-file-events";
import { VaultEventQueue } from "../src/vault-event-queue";

type File = { path: string };

function blockedQueue() {
	const queue = new VaultEventQueue();
	let release!: () => void;
	queue.enqueue(
		{ type: "create", path: "blocker.md" },
		() => new Promise<void>((resolve) => (release = resolve)),
	);
	return { queue, release: () => release() };
}

describe("queued Vault file events", () => {
	it("snapshots a modify path and resolves its file only when the event executes", async () => {
		const { queue, release } = blockedQueue();
		const eventFile = { path: "A.md" };
		const currentA = { path: "A.md" };
		const files = new Map<string, File>([["A.md", currentA]]);
		const onModify = vi.fn();

		enqueueVaultModify(queue, eventFile, (path) => files.get(path) ?? null, onModify);
		eventFile.path = "B.md";
		await Promise.resolve();
		release();
		await queue.whenIdle();

		expect(onModify).toHaveBeenCalledWith(currentA);
		expect(onModify).not.toHaveBeenCalledWith(eventFile);
	});

	it("does not resolve or read an unrelated Markdown file", async () => {
		const queue = new VaultEventQueue();
		const resolve = vi.fn(() => ({ path: "Unrelated.md" }));
		const onModify = vi.fn();

		enqueueVaultModify(queue, { path: "Unrelated.md" }, resolve, onModify, () => false);
		await queue.whenIdle();

		expect(resolve).not.toHaveBeenCalled();
		expect(onModify).not.toHaveBeenCalled();
	});

	it("evaluates queue membership when a delayed modify executes", async () => {
		const { queue, release } = blockedQueue();
		let isQueued = false;
		const current = { path: "Later.md" };
		const onModify = vi.fn();
		enqueueVaultModify(
			queue,
			current,
			() => current,
			onModify,
			() => isQueued,
		);

		await Promise.resolve();
		isQueued = true;
		release();
		await queue.whenIdle();

		expect(onModify).toHaveBeenCalledWith(current);
	});

	it("reads and refreshes only once for a burst on the same path", async () => {
		const { queue, release } = blockedQueue();
		const current = { path: "Burst.md" };
		const resolve = vi.fn(() => current);
		const onModify = vi.fn();

		for (let index = 0; index < 20; index += 1) {
			enqueueVaultModify(queue, current, resolve, onModify);
		}
		await Promise.resolve();
		release();
		await queue.whenIdle();

		expect(resolve).toHaveBeenCalledOnce();
		expect(onModify).toHaveBeenCalledOnce();
	});

	it("preserves A to B to C transitions when B no longer exists at execution time", async () => {
		const { queue, release } = blockedQueue();
		const eventFile = { path: "B.md" };
		const files = new Map<string, File>();
		let queuePath = "A.md";
		let unavailable = false;
		const rename = vi.fn((path: string, oldPath: string) => {
			if (queuePath === oldPath) queuePath = path;
		});

		enqueueVaultRename(queue, eventFile, "A.md", (path) => files.get(path) ?? null, rename);
		eventFile.path = "C.md";
		files.set("C.md", eventFile);
		enqueueVaultRename(queue, eventFile, "B.md", (path) => files.get(path) ?? null, rename);
		queue.enqueue({ type: "delete", path: "C.md" }, () => {
			if (queuePath === "C.md") unavailable = true;
		});

		await Promise.resolve();
		release();
		await queue.whenIdle();

		expect(rename).toHaveBeenNthCalledWith(1, "B.md", "A.md", null);
		expect(rename).toHaveBeenNthCalledWith(2, "C.md", "B.md", eventFile);
		expect(queuePath).toBe("C.md");
		expect(unavailable).toBe(true);
	});

	it("delivers a Markdown to non-Markdown rename with no readable current file", async () => {
		const queue = new VaultEventQueue();
		const renamedFile = { path: "A.txt" };
		const onRename = vi.fn();

		enqueueVaultRename(queue, renamedFile, "A.md", () => null, onRename);
		await queue.whenIdle();

		expect(onRename).toHaveBeenCalledWith("A.txt", "A.md", null);
	});
});
