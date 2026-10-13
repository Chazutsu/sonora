import { describe, expect, it, vi } from "vitest";
import { FileRefreshCoordinator } from "../src/file-refresh-coordinator";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("FileRefreshCoordinator", () => {
	it("discards an older modify result when reads complete in reverse order", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const coordinator = new FileRefreshCoordinator(read, (source) => source.toUpperCase());

		const modifyA = coordinator.refresh("Notes/A.md");
		const modifyB = coordinator.refresh("Notes/A.md");
		second.resolve("new");
		await expect(modifyB).resolves.toMatchObject({ status: "current", value: "NEW" });
		first.resolve("old");
		await expect(modifyA).resolves.toEqual({
			status: "stale",
			path: "Notes/A.md",
			generation: 1,
		});
	});

	it("invalidates an in-flight modify after delete", async () => {
		const pending = deferred<string>();
		const coordinator = new FileRefreshCoordinator(
			() => pending.promise,
			(source) => source,
		);

		const modify = coordinator.refresh("Notes/Deleted.md");
		expect(coordinator.invalidate("Notes/Deleted.md")).toBe(2);
		pending.resolve("content returned after delete");

		await expect(modify).resolves.toMatchObject({ status: "stale" });
	});

	it("delivers one current result to multiple consumers for the same path", async () => {
		const firstConsumer = vi.fn();
		const secondConsumer = vi.fn();
		const coordinator = new FileRefreshCoordinator(
			async () => "body",
			(source, path) => ({ source, path }),
		);

		const result = await coordinator.refreshAndConsume(
			"Notes/Shared.md",
			firstConsumer,
			secondConsumer,
		);

		expect(result).toMatchObject({ status: "current", value: { source: "body" } });
		expect(firstConsumer).toHaveBeenCalledOnce();
		expect(secondConsumer).toHaveBeenCalledOnce();
		expect(firstConsumer.mock.calls[0]?.[0]).toBe(secondConsumer.mock.calls[0]?.[0]);
	});

	it("suppresses a stale read error after invalidation", async () => {
		const pending = deferred<string>();
		const coordinator = new FileRefreshCoordinator(
			() => pending.promise,
			(source) => source,
		);

		const refresh = coordinator.refresh("Notes/Renamed.md");
		coordinator.invalidate("Notes/Renamed.md");
		pending.reject(new Error("file no longer exists"));

		await expect(refresh).resolves.toMatchObject({ status: "stale" });
	});

	it("forgets inactive paths without allowing an old read to become current again", async () => {
		const oldRead = deferred<string>();
		const read = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce("new");
		const coordinator = new FileRefreshCoordinator(read, (source) => source);
		const oldRefresh = coordinator.refresh("Notes/Renamed.md");

		coordinator.invalidate("Notes/Renamed.md");
		coordinator.forget("Notes/Renamed.md");
		await expect(coordinator.refresh("Notes/Renamed.md")).resolves.toMatchObject({
			status: "current",
			value: "new",
		});
		oldRead.resolve("old");

		await expect(oldRefresh).resolves.toMatchObject({ status: "stale" });
		expect(coordinator.currentGeneration("Notes/Renamed.md")).toBeGreaterThan(0);
	});

	it("prunes a completed generation only while it is still current", async () => {
		const coordinator = new FileRefreshCoordinator(
			async () => "body",
			(source) => source,
		);
		const first = await coordinator.refresh("Notes/A.md");
		expect(first.status).toBe("current");
		if (first.status !== "current") return;
		expect(coordinator.forgetIfCurrent(first.path, first.generation)).toBe(true);
		expect(coordinator.currentGeneration(first.path)).toBe(0);

		const second = await coordinator.refresh("Notes/A.md");
		expect(second.status).toBe("current");
		if (second.status !== "current") return;
		coordinator.invalidate(second.path);
		expect(coordinator.forgetIfCurrent(second.path, second.generation)).toBe(false);
		expect(coordinator.currentGeneration(second.path)).toBeGreaterThan(second.generation);
	});
});
