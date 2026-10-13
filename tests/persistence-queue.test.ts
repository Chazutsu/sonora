import { describe, expect, it, vi } from "vitest";
import { PersistenceQueue } from "../src/persistence-queue";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("PersistenceQueue", () => {
	it("runs one write at a time and coalesces queued snapshots to the latest", async () => {
		const first = deferred();
		const written: number[] = [];
		const write = vi.fn(async (snapshot: number) => {
			written.push(snapshot);
			if (snapshot === 1) await first.promise;
		});
		const queue = new PersistenceQueue(write);

		const idle = queue.save(1);
		void queue.save(2);
		void queue.save(3);
		expect(write).toHaveBeenCalledTimes(1);

		first.resolve();
		await idle;
		expect(written).toEqual([1, 3]);
		expect(queue.dirty).toBe(false);
	});

	it("keeps failed state dirty and retries without rejecting callers", async () => {
		const error = new Error("disk full");
		const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
		const onError = vi.fn();
		const queue = new PersistenceQueue<string>(write, { onError });

		await expect(queue.save("latest")).resolves.toBeUndefined();
		expect(queue.dirty).toBe(true);
		expect(onError).toHaveBeenCalledOnce();

		await queue.retry();
		expect(write).toHaveBeenCalledTimes(2);
		expect(queue.dirty).toBe(false);
	});

	it("reports whether a critical snapshot became durable", async () => {
		const write = vi.fn().mockRejectedValueOnce(new Error("iCloud unavailable"));
		const queue = new PersistenceQueue(write);

		await expect(queue.saveCritical("advance")).resolves.toBe(false);
		expect(queue.dirty).toBe(true);

		write.mockResolvedValueOnce(undefined);
		await expect(queue.saveCritical("rollback")).resolves.toBe(true);
		expect(queue.dirty).toBe(false);
	});

	it("acknowledges the exact critical revision even when a later normal save fails", async () => {
		const criticalWrite = deferred();
		const normalWrite = deferred();
		const queue = new PersistenceQueue<string>(async (snapshot) => {
			if (snapshot === "critical") await criticalWrite.promise;
			if (snapshot === "normal") await normalWrite.promise;
		});

		const criticalResult = queue.saveCritical("critical");
		void queue.save("normal");
		criticalWrite.resolve();
		await expect(criticalResult).resolves.toBe(true);

		normalWrite.reject(new Error("later background save failed"));
		await queue.whenIdle();
		expect(queue.dirty).toBe(true);
	});

	it("does not acknowledge a critical revision coalesced by a newer normal save", async () => {
		const firstWrite = deferred();
		const written: string[] = [];
		const queue = new PersistenceQueue<string>(async (snapshot) => {
			written.push(snapshot);
			if (snapshot === "in-flight") await firstWrite.promise;
		});

		void queue.save("in-flight");
		const criticalResult = queue.saveCritical("critical");
		void queue.save("newer-normal");
		await expect(criticalResult).resolves.toBe(false);
		firstWrite.resolve();
		await queue.whenIdle();

		expect(written).toEqual(["in-flight", "newer-normal"]);
		expect(queue.dirty).toBe(false);
	});

	it("retains a newer snapshot when an older in-flight write fails", async () => {
		const first = deferred();
		const error = new Error("failed");
		const written: string[] = [];
		const queue = new PersistenceQueue<string>(async (snapshot) => {
			written.push(snapshot);
			if (snapshot === "old") await first.promise;
		});

		const idle = queue.save("old");
		void queue.save("new");
		first.reject(error);
		await idle;
		await queue.retry();

		expect(written).toEqual(["old", "new"]);
		expect(queue.dirty).toBe(false);
	});

	it("writes a newer snapshot queued during a failure without requiring retry", async () => {
		const first = deferred();
		const written: string[] = [];
		const onError = vi.fn();
		const queue = new PersistenceQueue<string>(
			async (snapshot) => {
				written.push(snapshot);
				if (snapshot === "removed") await first.promise;
			},
			{ onError },
		);

		const idle = queue.save("removed");
		void queue.save("restored");
		first.reject(new Error("failed removal write"));
		await idle;

		expect(written).toEqual(["removed", "restored"]);
		expect(queue.dirty).toBe(false);
		expect(onError).not.toHaveBeenCalled();
	});

	it("deduplicates repeated reports of the same error until a success", async () => {
		const error = new Error("offline");
		const onError = vi.fn();
		const write = vi.fn().mockRejectedValue(error);
		const queue = new PersistenceQueue(write, { onError });

		await queue.save({ revision: 1 });
		await queue.retry();
		expect(onError).toHaveBeenCalledOnce();
	});

	it("does not retry or start new writes after disposal", async () => {
		const write = vi.fn().mockRejectedValue(new Error("offline"));
		const queue = new PersistenceQueue(write);
		await queue.save("pending");

		queue.dispose();
		await queue.retry();
		await queue.save("ignored");

		expect(write).toHaveBeenCalledOnce();
		expect(queue.dirty).toBe(true);
		expect(queue.isDisposed).toBe(true);
	});

	it("suppresses a late failure callback after disposal", async () => {
		const pending = deferred();
		const onError = vi.fn();
		const queue = new PersistenceQueue(() => pending.promise, { onError });
		const idle = queue.save("in flight");

		queue.dispose();
		pending.reject(new Error("late failure"));
		await idle;

		expect(onError).not.toHaveBeenCalled();
		expect(queue.dirty).toBe(true);
		await queue.retry();
	});

	it("flushes the newest queued snapshot before an in-flight disposal completes", async () => {
		const first = deferred();
		const written: string[] = [];
		const queue = new PersistenceQueue<string>(async (snapshot) => {
			written.push(snapshot);
			if (snapshot === "old") await first.promise;
		});
		const idle = queue.save("old");
		void queue.save("new");

		queue.dispose();
		first.resolve();
		await idle;

		expect(written).toEqual(["old", "new"]);
		expect(queue.isDisposed).toBe(true);
	});
});
