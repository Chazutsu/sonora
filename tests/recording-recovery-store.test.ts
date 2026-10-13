import { describe, expect, it, vi } from "vitest";
import {
	RecordingRecoveryStore,
	type RecordingRecoveryAdapter,
} from "../src/recording-recovery-store";

class MemoryAdapter implements RecordingRecoveryAdapter {
	readonly files = new Map<string, string | ArrayBuffer>();
	readonly folders = new Set<string>();
	async exists(path: string) {
		return this.files.has(path) || this.folders.has(path);
	}
	async list(path: string) {
		const prefix = `${path}/`;
		return {
			files: [...this.files.keys()].filter(
				(item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"),
			),
			folders: [...this.folders].filter(
				(item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"),
			),
		};
	}
	async read(path: string) {
		const value = this.files.get(path);
		if (typeof value !== "string") throw new Error("not text");
		return value;
	}
	async readBinary(path: string) {
		const value = this.files.get(path);
		if (!(value instanceof ArrayBuffer)) throw new Error("not binary");
		return value;
	}
	async stat(path: string) {
		const value = this.files.get(path);
		if (value instanceof ArrayBuffer) return { size: value.byteLength };
		if (typeof value === "string") return { size: value.length };
		return null;
	}
	async write(path: string, data: string) {
		this.files.set(path, data);
	}
	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, data);
	}
	async remove(path: string) {
		this.files.delete(path);
	}
	async rename(from: string, to: string) {
		for (const [path, value] of Array.from(this.files)) {
			if (path === from || path.startsWith(`${from}/`)) {
				this.files.delete(path);
				this.files.set(`${to}${path.slice(from.length)}`, value);
			}
		}
		for (const path of Array.from(this.folders)) {
			if (path === from || path.startsWith(`${from}/`)) {
				this.folders.delete(path);
				this.folders.add(`${to}${path.slice(from.length)}`);
			}
		}
	}
	async rmdir(path: string) {
		this.folders.delete(path);
	}
}

function fixture(installId = "mac-1", now = 1_000) {
	const adapter = new MemoryAdapter();
	const root = "Sonora/Voice memos/.sonora-pending";
	adapter.folders.add(root);
	const store = new RecordingRecoveryStore<{ itemId: string }>({
		adapter,
		root,
		installId,
		now: () => now,
		staleAfterMs: 100,
		delay: async () => undefined,
		ensureFolder: async (path) => void adapter.folders.add(path),
	});
	return { adapter, root, store };
}

describe("RecordingRecoveryStore", () => {
	it("recovers finalized parts in manifest order and removes only after confirmation", async () => {
		const { adapter, store } = fixture();
		await store.begin({
			sessionId: "s1",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 900,
		});
		await store.append({ sessionId: "s1", index: 0, blob: new Blob(["ab"]) });
		await store.append({ sessionId: "s1", index: 1, blob: new Blob(["cd"]) });
		await store.markReady({
			recoveryId: "s1",
			context: { itemId: "i1" },
			blob: new Blob(["abcd"]),
			mimeType: "audio/webm",
			size: 4,
			startedAt: 900,
			stoppedAt: 1_000,
			durationMs: 100,
			limit: null,
		});

		const recovered = await store.recover();
		expect(recovered).toHaveLength(1);
		expect(await recovered[0]?.blob.text()).toBe("abcd");
		expect(adapter.files.size).toBe(10);
		await store.remove("s1");
		expect(adapter.files.size).toBe(0);
	});

	it("does not steal a live or stale active session from another installation", async () => {
		const shared = fixture("iphone", 1_000);
		await shared.store.begin({
			sessionId: "phone",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await shared.store.append({ sessionId: "phone", index: 0, blob: new Blob(["audio"]) });
		const macStore = new RecordingRecoveryStore<{ itemId: string }>({
			adapter: shared.adapter,
			root: shared.root,
			installId: "mac",
			now: () => 10_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async () => undefined,
		});
		expect(await macStore.recover()).toEqual([]);
	});

	it("recovers a stale active session from the same installation", async () => {
		const shared = fixture("mac", 1_000);
		await shared.store.begin({
			sessionId: "stale",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await shared.store.append({ sessionId: "stale", index: 0, blob: new Blob(["audio"]) });
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter: shared.adapter,
			root: shared.root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async () => undefined,
		});
		expect(await restarted.recover()).toHaveLength(1);
	});

	it("fails closed on a missing or corrupt part", async () => {
		const { adapter, store } = fixture();
		await store.begin({
			sessionId: "broken",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "broken", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "broken",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		const partPath = [...adapter.files.keys()].find(
			(candidatePath) => candidatePath.includes("/broken/tail-") && candidatePath.endsWith(".part"),
		);
		expect(partPath).toBeDefined();
		adapter.files.set(partPath!, new ArrayBuffer(1));
		expect(await store.recover()).toEqual([]);
		expect(
			[...adapter.files.keys()].some(
				(candidatePath) =>
					candidatePath.includes("/.quarantine/broken-") && candidatePath.includes("/manifest-"),
			),
		).toBe(true);
	});

	it("rejects duplicate immutable part indexes", async () => {
		const { store } = fixture();
		await store.begin({
			sessionId: "s1",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "s1", index: 0, blob: new Blob(["a"]) });
		await expect(
			store.append({ sessionId: "s1", index: 0, blob: new Blob(["b"]) }),
		).rejects.toThrow("not contiguous");
	});

	it("fails closed when another installation also claims a ready session", async () => {
		const { adapter, root, store } = fixture("mac");
		await store.begin({
			sessionId: "shared",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "shared", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "shared",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		const claims = `${root}/shared/claims`;
		adapter.folders.add(claims);
		adapter.files.set(
			`${claims}/iphone.json`,
			JSON.stringify({
				sessionId: "shared",
				installId: "iphone",
				createdAt: 900,
				expiresAt: 2_000,
				epoch: 900,
			}),
		);
		expect(await store.recover()).toEqual([]);
		expect(adapter.files.has(`${claims}/mac.json`)).toBe(false);
	});

	it("cleans an expired foreign lease and re-elects the current installation", async () => {
		const { adapter, root, store } = fixture("mac");
		await store.begin({
			sessionId: "expired",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "expired", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "expired",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		const claims = `${root}/expired/claims`;
		adapter.folders.add(claims);
		adapter.files.set(
			`${claims}/iphone.json`,
			JSON.stringify({
				sessionId: "expired",
				installId: "iphone",
				createdAt: 100,
				expiresAt: -100_000,
				epoch: 100,
			}),
		);
		expect(await store.recover()).toHaveLength(1);
		expect(adapter.files.has(`${claims}/iphone.json`)).toBe(false);
	});

	it("stores every one-second chunk as a distinct immutable part", async () => {
		const { adapter, root, store } = fixture();
		await store.begin({
			sessionId: "bundle",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		for (let index = 0; index < 10; index += 1)
			await store.append({ sessionId: "bundle", index, blob: new Blob([String(index)]) });
		expect(
			[...adapter.files.keys()].filter(
				(path) => path.startsWith(`${root}/bundle/tail-`) && path.endsWith(".part"),
			),
		).toHaveLength(10);
		expect(adapter.files.has(`${root}/bundle/current.part`)).toBe(false);
	});

	it("refuses new checkpoints when the conservative pending-session cap is reached", async () => {
		const { adapter, root } = fixture();
		const store = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			maxPendingSessions: 1,
			ensureFolder: async (path) => void adapter.folders.add(path),
			delay: async () => undefined,
		});
		await store.begin({
			sessionId: "one",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await expect(
			store.begin({
				sessionId: "two",
				context: { itemId: "i2" },
				mimeType: "audio/webm",
				startedAt: 0,
			}),
		).rejects.toThrow("pending-session limit");
	});

	it("garbage-collects only provably empty orphan folders", async () => {
		const { adapter, root, store } = fixture();
		adapter.folders.add(`${root}/empty-orphan`);
		await store.begin({
			sessionId: "safe",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		expect(adapter.folders.has(`${root}/empty-orphan`)).toBe(false);
		expect(
			[...adapter.files.keys()].some((candidatePath) =>
				candidatePath.startsWith(`${root}/safe/manifest-`),
			),
		).toBe(true);
	});

	it("adopts a single immutable tail written before a manifest commit", async () => {
		const shared = fixture("mac", 1_000);
		await shared.store.begin({
			sessionId: "crash",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		const path = `${shared.root}/crash/tail-000000-after-write.part`;
		const data = await new Blob(["tail"]).arrayBuffer();
		shared.adapter.files.set(path, data);
		const digest = await crypto.subtle.digest("SHA-256", data);
		const sha256 = [...new Uint8Array(digest)]
			.map((value) => value.toString(16).padStart(2, "0"))
			.join("");
		shared.adapter.files.set(
			`${path}.commit.json`,
			JSON.stringify({ sessionId: "crash", index: 0, size: data.byteLength, sha256 }),
		);
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter: shared.adapter,
			root: shared.root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async (folderPath) => void shared.adapter.folders.add(folderPath),
		});
		const recovered = await restarted.recover();
		expect(recovered).toHaveLength(1);
		expect(await recovered[0]?.blob.text()).toBe("tail");
	});

	it("quarantines ambiguous tails locally without blocking a new session", async () => {
		const { adapter, root, store } = fixture();
		await store.begin({
			sessionId: "ambiguous",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		adapter.files.set(`${root}/ambiguous/tail-000000-a.part`, new ArrayBuffer(1));
		adapter.files.set(`${root}/ambiguous/tail-000000-b.part`, new ArrayBuffer(1));
		await expect(
			store.append({ sessionId: "ambiguous", index: 0, blob: new Blob(["x"]) }),
		).rejects.toThrow("Ambiguous");
		await expect(
			store.begin({
				sessionId: "healthy",
				context: { itemId: "i2" },
				mimeType: "audio/webm",
				startedAt: 0,
			}),
		).resolves.toBeUndefined();
	});

	it("keeps a slightly expired foreign lease under clock-skew tolerance", async () => {
		const { adapter, root, store } = fixture("mac", 10_000);
		await store.begin({
			sessionId: "skew",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "skew", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "skew",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		const claims = `${root}/skew/claims`;
		adapter.folders.add(claims);
		adapter.files.set(
			`${claims}/iphone.json`,
			JSON.stringify({
				sessionId: "skew",
				installId: "iphone",
				createdAt: 1,
				expiresAt: 9_000,
				epoch: 1,
			}),
		);
		expect(await store.recover()).toEqual([]);
		expect(adapter.files.has(`${claims}/iphone.json`)).toBe(true);
	});

	it("detects a late-visible winning claim before processing", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "late",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "late", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "late",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		expect(await store.recover()).toHaveLength(1);
		const claims = `${root}/late/claims`;
		adapter.files.set(
			`${claims}/iphone.json`,
			JSON.stringify({
				sessionId: "late",
				installId: "iphone",
				createdAt: 1,
				expiresAt: 50_000,
				epoch: 1,
			}),
		);
		await expect(store.withClaim("late", async () => undefined)).rejects.toThrow("ownership");
		expect(
			[...adapter.files.keys()].some((candidatePath) =>
				candidatePath.startsWith(`${root}/late/manifest-`),
			),
		).toBe(true);
	});

	it("renews ownership during processing longer than the base lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const adapter = new MemoryAdapter();
		const root = "Sonora/Voice memos/.sonora-pending";
		adapter.folders.add(root);
		const store = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			now: Date.now,
			staleAfterMs: 0,
			claimLeaseMs: 3_000,
			claimClockSkewMs: 0,
			delay: async () => undefined,
			ensureFolder: async (path) => void adapter.folders.add(path),
		});
		await store.begin({
			sessionId: "long",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "long", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "long",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		expect(await store.recover()).toHaveLength(1);
		await store.withClaim("long", async () => void (await vi.advanceTimersByTimeAsync(16_000)));
		vi.useRealTimers();
	});

	it("can retry inventory cleanup after a remove fault", async () => {
		const { adapter, root, store } = fixture();
		await store.begin({
			sessionId: "cleanup",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "cleanup", index: 0, blob: new Blob(["audio"]) });
		const originalRemove = adapter.remove.bind(adapter);
		let failed = false;
		adapter.remove = async (path) => {
			if (!failed) {
				failed = true;
				throw new Error("injected remove fault");
			}
			await originalRemove(path);
		};
		await expect(store.remove("cleanup")).rejects.toThrow("injected");
		await expect(store.remove("cleanup")).resolves.toBeUndefined();
		expect([...adapter.files.keys()].some((path) => path.startsWith(`${root}/cleanup/`))).toBe(
			false,
		);
	});

	it("leaves no part when the binary write itself fails", async () => {
		const { adapter, root, store } = fixture();
		await store.begin({
			sessionId: "binary-fault",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		adapter.writeBinary = async () => {
			throw new Error("binary write fault");
		};
		await expect(
			store.append({ sessionId: "binary-fault", index: 0, blob: new Blob(["audio"]) }),
		).rejects.toThrow("binary write fault");
		expect(
			[...adapter.files.keys()].some((candidate) =>
				candidate.startsWith(`${root}/binary-fault/tail-`),
			),
		).toBe(false);
	});

	it("quarantines a part whose sidecar write failed", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "sidecar-fault",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		const originalWrite = adapter.write.bind(adapter);
		adapter.write = async (path, data) => {
			if (path.endsWith(".commit.json")) throw new Error("sidecar write fault");
			await originalWrite(path, data);
		};
		await expect(
			store.append({ sessionId: "sidecar-fault", index: 0, blob: new Blob(["audio"]) }),
		).rejects.toThrow("sidecar write fault");
		adapter.write = originalWrite;
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async (path) => void adapter.folders.add(path),
		});
		expect(await restarted.recover()).toEqual([]);
		expect(
			[...adapter.files.keys()].some(
				(candidate) =>
					candidate.includes("/.quarantine/sidecar-fault-") && candidate.endsWith(".part"),
			),
		).toBe(true);
	});

	it("adopts a sidecar-verified part after the manifest commit write fails", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "manifest-fault",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		const originalWrite = adapter.write.bind(adapter);
		let failed = false;
		adapter.write = async (path, data) => {
			if (
				!failed &&
				path.includes("/manifest-") &&
				[...adapter.files.keys()].some((candidate) => candidate.endsWith(".commit.json"))
			) {
				failed = true;
				throw new Error("manifest commit fault");
			}
			await originalWrite(path, data);
		};
		await expect(
			store.append({ sessionId: "manifest-fault", index: 0, blob: new Blob(["audio"]) }),
		).rejects.toThrow("manifest commit fault");
		adapter.write = originalWrite;
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async (path) => void adapter.folders.add(path),
		});
		expect(await restarted.recover()).toHaveLength(1);
	});

	it("counts quarantined binaries toward the global byte cap", async () => {
		const adapter = new MemoryAdapter();
		const root = "Sonora/Voice memos/.sonora-pending";
		adapter.folders.add(root);
		adapter.folders.add(`${root}/.quarantine`);
		adapter.folders.add(`${root}/.quarantine/old`);
		adapter.files.set(`${root}/.quarantine/old/tail-000000-old.part`, new ArrayBuffer(4));
		const store = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			maxPendingBytes: 3,
			ensureFolder: async (folderPath) => void adapter.folders.add(folderPath),
		});
		await expect(
			store.begin({
				sessionId: "new",
				context: { itemId: "i1" },
				mimeType: "audio/webm",
				startedAt: 0,
			}),
		).rejects.toThrow("pending-byte limit");
	});

	it("rejects a same-install claim when its epoch changed", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "epoch",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "epoch", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "epoch",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		expect(await store.recover()).toHaveLength(1);
		adapter.files.set(
			`${root}/epoch/claims/mac.json`,
			JSON.stringify({
				sessionId: "epoch",
				installId: "mac",
				createdAt: 1_000,
				expiresAt: 50_000,
				epoch: 999,
			}),
		);
		await expect(store.withClaim("epoch", async () => undefined)).rejects.toThrow("ownership");
	});

	it("falls back from a truncated newest manifest generation", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "truncated",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "truncated", index: 0, blob: new Blob(["audio"]) });
		const manifests = [...adapter.files.keys()]
			.filter((candidate) => candidate.startsWith(`${root}/truncated/manifest-`))
			.toSorted();
		adapter.files.set(manifests.at(-1)!, "{truncated");
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async (folderPath) => void adapter.folders.add(folderPath),
		});
		expect(await restarted.recover()).toHaveLength(1);
	});

	it("ignores a corrupt manifest pointer and scans immutable generations", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "pointer",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		await store.append({ sessionId: "pointer", index: 0, blob: new Blob(["audio"]) });
		await store.markReady({
			recoveryId: "pointer",
			context: { itemId: "i1" },
			blob: new Blob(["audio"]),
			mimeType: "audio/webm",
			size: 5,
			startedAt: 0,
			stoppedAt: 1,
			durationMs: 1,
			limit: null,
		});
		adapter.files.set(`${root}/pointer/manifest-pointer.json`, "not json");
		expect(await store.recover()).toHaveLength(1);
	});

	it("recovers a manifest generation written before its pointer update failed", async () => {
		const { adapter, root, store } = fixture("mac", 1_000);
		await store.begin({
			sessionId: "pointer-fault",
			context: { itemId: "i1" },
			mimeType: "audio/webm",
			startedAt: 0,
		});
		const originalWrite = adapter.write.bind(adapter);
		let failed = false;
		adapter.write = async (path, data) => {
			if (
				!failed &&
				path.endsWith("/manifest-pointer.json") &&
				[...adapter.files.keys()].some((candidate) => candidate.endsWith(".commit.json"))
			) {
				failed = true;
				throw new Error("pointer fault");
			}
			await originalWrite(path, data);
		};
		await expect(
			store.append({ sessionId: "pointer-fault", index: 0, blob: new Blob(["audio"]) }),
		).rejects.toThrow("pointer fault");
		adapter.write = originalWrite;
		const restarted = new RecordingRecoveryStore<{ itemId: string }>({
			adapter,
			root,
			installId: "mac",
			now: () => 2_000,
			staleAfterMs: 100,
			delay: async () => undefined,
			ensureFolder: async (folderPath) => void adapter.folders.add(folderPath),
		});
		expect(await restarted.recover()).toHaveLength(1);
	});
});
