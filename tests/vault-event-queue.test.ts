import { describe, expect, it, vi } from "vitest";
import { VaultEventQueue } from "../src/vault-event-queue";

describe("VaultEventQueue", () => {
	it("runs asynchronous Vault events strictly in arrival order", async () => {
		const queue = new VaultEventQueue();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));

		queue.enqueue({ type: "modify", path: "note.md" }, async ({ sequence }) => {
			order.push(`start-${sequence}`);
			await gate;
			order.push(`end-${sequence}`);
		});
		queue.enqueue({ type: "rename", path: "renamed.md" }, ({ sequence }) => {
			order.push(`start-${sequence}`);
			order.push(`end-${sequence}`);
		});

		await Promise.resolve();
		expect(order).toEqual(["start-1"]);
		release();
		await queue.whenIdle();
		expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
	});

	it("reports a failure and continues with the following event", async () => {
		const onError = vi.fn();
		const queue = new VaultEventQueue({ onError });
		const next = vi.fn();
		const error = new Error("read failed");
		queue.enqueue({ type: "modify", path: "note.md" }, () => {
			throw error;
		});
		queue.enqueue({ type: "delete", path: "note.md" }, next);
		await queue.whenIdle();
		expect(onError).toHaveBeenCalledWith({
			event: { type: "modify", path: "note.md" },
			sequence: 1,
			error,
		});
		expect(next).toHaveBeenCalledOnce();
	});

	it("continues even when the error reporter itself throws", async () => {
		const queue = new VaultEventQueue({
			onError: () => {
				throw new Error("diagnostics failed");
			},
		});
		const next = vi.fn();
		queue.enqueue({ type: "modify", path: "note.md" }, () => {
			throw new Error("read failed");
		});
		queue.enqueue({ type: "delete", path: "note.md" }, next);
		await expect(queue.whenIdle()).resolves.toBeUndefined();
		expect(next).toHaveBeenCalledOnce();
	});

	it("drains accepted work on close and rejects new events", async () => {
		const queue = new VaultEventQueue();
		const operation = vi.fn();
		expect(queue.enqueue({ type: "create", path: "note.md" }, operation)).toBe(true);
		const drained = queue.close();
		expect(queue.enqueue({ type: "modify", path: "note.md" }, operation)).toBe(false);
		await drained;
		expect(operation).toHaveBeenCalledOnce();
		expect(queue.isAccepting()).toBe(false);
	});

	it("can discard callbacks that have not started when unloading", async () => {
		const queue = new VaultEventQueue();
		let release!: () => void;
		const started = vi.fn();
		const pending = vi.fn();
		queue.enqueue(
			{ type: "modify", path: "active.md" },
			() =>
				new Promise<void>((resolve) => {
					started();
					release = resolve;
				}),
		);
		queue.enqueue({ type: "modify", path: "pending.md" }, pending);
		await Promise.resolve();

		const closed = queue.close({ discardPending: true });
		release();
		await closed;

		expect(started).toHaveBeenCalledOnce();
		expect(pending).not.toHaveBeenCalled();
	});

	it("coalesces an unstarted burst to the latest operation for one path", async () => {
		const queue = new VaultEventQueue();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const calls: string[] = [];
		queue.enqueue({ type: "initialize", path: "/" }, () => gate);
		queue.enqueueLatest("note.md", { type: "modify", path: "note.md" }, () => {
			calls.push("old");
		});
		queue.enqueueLatest("note.md", { type: "modify", path: "note.md" }, ({ sequence }) => {
			calls.push(`latest-${sequence}`);
		});

		release();
		await queue.whenIdle();
		expect(calls).toEqual(["latest-3"]);
	});

	it("does not coalesce modifies across rename and delete barriers", async () => {
		const queue = new VaultEventQueue();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const calls: string[] = [];
		queue.enqueue({ type: "initialize", path: "/" }, () => gate);
		queue.enqueueLatest("old.md", { type: "modify", path: "old.md" }, () => {
			calls.push("modify-old");
		});
		queue.enqueue({ type: "rename", path: "new.md" }, () => {
			calls.push("rename");
		});
		queue.enqueueLatest("new.md", { type: "modify", path: "new.md" }, () => {
			calls.push("modify-new");
		});
		queue.enqueue({ type: "delete", path: "new.md" }, () => {
			calls.push("delete");
		});

		release();
		await queue.whenIdle();
		expect(calls).toEqual(["modify-old", "rename", "modify-new", "delete"]);
	});

	it("continues draining latest work after a coalesced operation fails", async () => {
		const onError = vi.fn();
		const queue = new VaultEventQueue({ onError });
		const next = vi.fn();
		queue.enqueueLatest("note.md", { type: "modify", path: "note.md" }, () => {
			throw new Error("latest read failed");
		});
		queue.enqueue({ type: "delete", path: "note.md" }, next);

		await queue.whenIdle();
		expect(onError).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();
	});

	it("reports pressure without dropping accepted work", async () => {
		const onPressure = vi.fn();
		const queue = new VaultEventQueue({ pressureThreshold: 2, onPressure });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const calls: string[] = [];
		queue.enqueue({ type: "initialize", path: "/" }, () => gate);
		queue.enqueueLatest("a.md", { type: "modify", path: "a.md" }, () => {
			calls.push("a");
		});
		queue.enqueueLatest("b.md", { type: "modify", path: "b.md" }, () => {
			calls.push("b");
		});

		expect(onPressure).toHaveBeenCalledWith(3);
		expect(queue.pending()).toBe(3);
		release();
		await queue.whenIdle();
		expect(calls).toEqual(["a", "b"]);
		expect(queue.pending()).toBe(0);
	});

	it("discards a coalesced pending operation on unload", async () => {
		const queue = new VaultEventQueue();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const pending = vi.fn();
		queue.enqueue({ type: "initialize", path: "/" }, () => gate);
		queue.enqueueLatest("note.md", { type: "modify", path: "note.md" }, pending);
		queue.enqueueLatest("note.md", { type: "modify", path: "note.md" }, pending);
		await Promise.resolve();

		const closed = queue.close({ discardPending: true });
		release();
		await closed;
		expect(pending).not.toHaveBeenCalled();
		expect(queue.pending()).toBe(0);
	});
});
