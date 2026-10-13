import { describe, expect, it, vi } from "vitest";
import { PersistenceJournal, type PersistenceJournalStorage } from "../src/persistence-journal";

type Snapshot = { revision: number };
const validateSnapshot = (value: unknown) => value as Snapshot;

function memoryStorage(): PersistenceJournalStorage & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		exists: async (path) => files.has(path),
		read: async (path) => {
			const value = files.get(path);
			if (value === undefined) throw new Error(`missing: ${path}`);
			return value;
		},
		write: async (path, data) => void files.set(path, data),
		remove: async (path) => void files.delete(path),
		rename: async (oldPath, newPath) => {
			const value = files.get(oldPath);
			if (value === undefined) throw new Error(`missing: ${oldPath}`);
			files.set(newPath, value);
			files.delete(oldPath);
		},
		list: async (path) => ({
			files: [...files.keys()].filter((file) => file.startsWith(path ? `${path}/` : "")),
			folders: [],
		}),
	};
}

async function commitAndClear(journal: PersistenceJournal<Snapshot>, snapshot: Snapshot) {
	const receipt = await journal.write(snapshot);
	await journal.commit([receipt]);
	await journal.clear(receipt);
}

describe("PersistenceJournal", () => {
	it("recovers a failed save and prevents a second-restart rollback", async () => {
		const storage = memoryStorage();
		const ids = ["old", "latest", "recovery-save"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		await journal.write({ revision: 1 });
		await journal.write({ revision: 2 });

		const recovery = await journal.load();
		expect(recovery?.snapshot).toEqual({ revision: 2 });
		await commitAndClear(journal, recovery!.snapshot);
		await journal.commit(recovery!.receipts);
		for (const receipt of recovery!.receipts) await journal.clear(receipt);

		await expect(journal.load()).resolves.toBeNull();
	});

	it("does not let an older writer delete a newer intent", async () => {
		const storage = memoryStorage();
		const ids = ["A", "B"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		const receiptA = await journal.write({ revision: 1 });
		const receiptB = await journal.write({ revision: 2 });

		await journal.commit([receiptA]);
		await journal.clear(receiptA);

		expect(storage.files.has(receiptB.path)).toBe(true);
		expect((await journal.load())?.snapshot).toEqual({ revision: 2 });
	});

	it("keeps an old generation when a newer generation write is interrupted", async () => {
		const storage = memoryStorage();
		const ids = ["old", "new"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		const old = await journal.write({ revision: 1 });
		const originalWrite = storage.write;
		storage.write = vi.fn(async (path, data) => {
			if (path.includes(".new.")) {
				storage.files.set(path, data.slice(0, 10));
				throw new Error("interrupted");
			}
			await originalWrite(path, data);
		});

		await expect(journal.write({ revision: 2 })).rejects.toThrow("interrupted");
		expect(storage.files.has(old.path)).toBe(true);
		expect((await journal.load())?.snapshot).toEqual({ revision: 1 });
	});

	it("fails closed when listing fails and does not perform a normal save", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(storage, "pending-save.json", validateSnapshot);
		await journal.load();
		storage.list = vi.fn().mockRejectedValue(new Error("File Provider unavailable"));
		const saveData = vi.fn();

		await expect(
			journal.write({ revision: 1 }).then(async (receipt) => {
				await saveData();
				await journal.commit([receipt]);
			}),
		).rejects.toThrow("File Provider unavailable");
		expect(saveData).not.toHaveBeenCalled();
	});

	it("rejects a partial listing that omits a manifest-indexed generation", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "pending",
		);
		const receipt = await journal.write({ revision: 1 });
		const originalList = storage.list;
		storage.list = vi.fn(async (path) => {
			const listed = await originalList(path);
			return { ...listed, files: listed.files.filter((file) => file !== receipt.path) };
		});

		await expect(journal.load()).rejects.toThrow("Missing Sonora persistence generation");
	});

	it("does not re-adopt a committed generation that later reappears", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "done",
		);
		const receipt = await journal.write({ revision: 1 });
		await journal.commit([receipt]);
		await journal.clear(receipt);
		storage.files.set(receipt.path, receipt.serialized);

		await expect(journal.load()).resolves.toBeNull();
	});

	it("orders generations by manifest sequence rather than a device clock", async () => {
		const storage = memoryStorage();
		const ids = ["clock-ahead", "clock-behind"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		await journal.write({ revision: 1 });
		await journal.write({ revision: 2 });

		expect((await journal.load())?.snapshot).toEqual({ revision: 2 });
	});

	it("re-adopts a prepared orphan left before the manifest rename", async () => {
		const storage = memoryStorage();
		storage.files.set(
			"pending-save.manifest.json",
			JSON.stringify({
				manifestVersion: 1,
				manifestId: "vault",
				nextSequence: 1,
				committedSequence: 0,
				pending: {},
				committedOperationIds: [],
			}),
		);
		storage.files.set(
			"pending-save.interrupted.json",
			JSON.stringify({
				journalVersion: 3,
				operationId: "interrupted",
				sequence: 1,
				snapshot: { revision: 2 },
			}),
		);
		const journal = new PersistenceJournal(storage, "pending-save.json", validateSnapshot);

		const recovery = await journal.load(undefined, { revision: 1 });

		expect(recovery?.snapshot).toEqual({ revision: 2 });
		expect(recovery?.receipts[0]).toMatchObject({
			operationId: "interrupted",
			sequence: 1,
		});
	});

	it("recovers the real schema-2 orphan fixture and reopens the journal", async () => {
		const storage = memoryStorage();
		const snapshot = {
			schemaVersion: 2,
			settings: { rate: 0.9 },
			queue: [],
			activeItemId: null,
			pendingVoiceMemoLinks: [],
		};
		storage.files.set(
			"pending-save.manifest.json",
			JSON.stringify({
				manifestVersion: 1,
				manifestId: "vault",
				nextSequence: 1,
				committedSequence: 0,
				pending: {},
				committedOperationIds: [],
			}),
		);
		const orphanPath = "pending-save.4b27.json";
		const serialized = JSON.stringify({
			journalVersion: 3,
			operationId: "4b27",
			sequence: 1,
			snapshot,
		});
		storage.files.set(orphanPath, serialized);
		const journal = new PersistenceJournal<Record<string, unknown>>(
			storage,
			"pending-save.json",
			(value) => value as Record<string, unknown>,
			() => "next",
		);

		const recovery = await journal.load(undefined, snapshot);
		expect(recovery?.snapshot).toEqual(snapshot);
		expect(storage.files.get(orphanPath)).toBe(serialized);
		const upgraded = { ...snapshot, schemaVersion: 3 };
		const current = await journal.write(upgraded);
		expect(current).toMatchObject({
			operationId: "next",
			sequence: 2,
		});
		await journal.commit([current]);
		await journal.clear(current);
		await journal.commit(recovery!.receipts);
		for (const receipt of recovery!.receipts) await journal.clear(receipt);
		await expect(journal.load(journal.watermark(current), upgraded)).resolves.toBeNull();
	});

	it("isolates an already-applied stale orphan without deleting its contents", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "next",
		);
		await journal.load();
		const manifestPath = [...storage.files.keys()].find((path) => path.includes(".manifest."))!;
		const manifest = JSON.parse(storage.files.get(manifestPath)!);
		storage.files.set(manifestPath, JSON.stringify({ ...manifest, nextSequence: 2 }));
		const orphanPath = "pending-save.applied.json";
		const serialized = JSON.stringify({
			journalVersion: 3,
			operationId: "applied",
			sequence: 1,
			snapshot: { revision: 1 },
		});
		storage.files.set(orphanPath, serialized);

		await expect(journal.load(undefined, { revision: 1 })).resolves.toBeNull();
		expect(storage.files.get(`${orphanPath}.orphan-applied-applied`)).toBe(serialized);
	});

	it("preserves a divergent stale orphan as ambiguous while reopening the journal", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "next",
		);
		await journal.load();
		const manifestPath = [...storage.files.keys()].find((path) => path.includes(".manifest."))!;
		const manifest = JSON.parse(storage.files.get(manifestPath)!);
		storage.files.set(manifestPath, JSON.stringify({ ...manifest, nextSequence: 2 }));
		const orphanPath = "pending-save.divergent.json";
		const serialized = JSON.stringify({
			journalVersion: 3,
			operationId: "divergent",
			sequence: 1,
			snapshot: { revision: 9 },
		});
		storage.files.set(orphanPath, serialized);

		await expect(journal.load(undefined, { revision: 1 })).resolves.toBeNull();
		expect(storage.files.get(`${orphanPath}.orphan-ambiguous-divergent`)).toBe(serialized);
		await expect(journal.write({ revision: 2 })).resolves.toMatchObject({ sequence: 2 });
	});

	it("fails closed when manifest and listed generations disagree", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(storage, "pending-save.json", validateSnapshot);
		await journal.load();
		storage.files.set(
			"pending-save.unknown.json",
			JSON.stringify({
				journalVersion: 3,
				operationId: "unknown",
				sequence: 99,
				snapshot: { revision: 9 },
			}),
		);

		await expect(journal.load()).rejects.toThrow("Unindexed Sonora persistence generation");
	});

	it("migrates the previous single-file journal format", async () => {
		const storage = memoryStorage();
		storage.files.set(
			"pending-save.json",
			JSON.stringify({ journalVersion: 1, snapshot: { revision: 4 } }),
		);
		const journal = new PersistenceJournal(storage, "pending-save.json", validateSnapshot);

		expect((await journal.load())?.snapshot).toEqual({ revision: 4 });
	});

	it("rejects a restored old manifest and generation after a newer commit", async () => {
		const storage = memoryStorage();
		const ids = ["old", "new"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		const old = await journal.write({ revision: 1 });
		await journal.commit([old]);
		const manifestPath = [...storage.files.keys()].find((path) => path.includes(".manifest."))!;
		const oldManifest = storage.files.get(manifestPath)!;
		const oldGeneration = old.serialized;
		await journal.clear(old);

		const current = await journal.write({ revision: 2 });
		const currentWatermark = journal.watermark(current);
		await journal.commit([current]);
		await journal.clear(current);
		storage.files.set(manifestPath, oldManifest);
		storage.files.set(old.path, oldGeneration);

		await expect(journal.load(currentWatermark)).rejects.toThrow(
			"manifest does not match data.json",
		);
	});

	it("recovers the prepared phase after data.json saves before manifest commit", async () => {
		const storage = memoryStorage();
		const ids = ["prepared", "recovery-save"];
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => ids.shift()!,
		);
		const prepared = await journal.write({ revision: 1 });
		const dataWatermark = journal.watermark(prepared);

		const restarted = await journal.load(dataWatermark);
		expect(restarted?.snapshot).toEqual({ revision: 1 });
		const recoverySave = await journal.write(restarted!.snapshot);
		const recoveredWatermark = journal.watermark(recoverySave);
		await journal.commit([recoverySave]);
		await journal.clear(recoverySave);
		await journal.commit(restarted!.receipts);
		for (const receipt of restarted!.receipts) await journal.clear(receipt);

		await expect(journal.load(recoveredWatermark)).resolves.toBeNull();
	});

	it("keeps the previous manifest head when atomic rename is interrupted", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "next",
		);
		await journal.load();
		const manifestPath = [...storage.files.keys()].find((path) => path.includes(".manifest."))!;
		const oldHead = storage.files.get(manifestPath);
		storage.rename = vi.fn().mockRejectedValue(new Error("rename interrupted"));

		await expect(journal.write({ revision: 1 })).rejects.toThrow("rename interrupted");
		expect(storage.files.get(manifestPath)).toBe(oldHead);
	});

	it("replaces the manifest without requiring rename to overwrite its destination", async () => {
		const storage = memoryStorage();
		const originalRename = storage.rename;
		storage.rename = vi.fn(async (oldPath, newPath) => {
			if (storage.files.has(newPath)) throw new Error(`destination exists: ${newPath}`);
			await originalRename(oldPath, newPath);
		});
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "prepared",
		);
		await journal.load();

		const receipt = await journal.write({ revision: 1 });

		expect(receipt).toMatchObject({ operationId: "prepared", sequence: 1 });
		expect((await journal.load())?.snapshot).toEqual({ revision: 1 });
	});

	it("recovers the newest valid manifest after replacement stops before promotion", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(storage, "pending-save.json", validateSnapshot);
		await journal.load();
		const manifestPath = "pending-save.manifest.json";
		const oldManifest = JSON.parse(storage.files.get(manifestPath)!);
		storage.files.set(`${manifestPath}.backup-crash`, storage.files.get(manifestPath)!);
		storage.files.delete(manifestPath);
		storage.files.set(
			"pending-save.recovered.json",
			JSON.stringify({
				journalVersion: 3,
				operationId: "recovered",
				sequence: 1,
				snapshot: { revision: 2 },
			}),
		);
		storage.files.set(
			`${manifestPath}.next-crash`,
			JSON.stringify({
				...oldManifest,
				nextSequence: 2,
				pending: { recovered: { path: "pending-save.recovered.json", sequence: 1 } },
			}),
		);

		const recovery = await journal.load();

		expect(recovery?.snapshot).toEqual({ revision: 2 });
		expect(storage.files.has(manifestPath)).toBe(true);
		expect(storage.files.has(`${manifestPath}.next-crash`)).toBe(false);
	});

	it("restores the previous manifest when promotion fails after moving the head", async () => {
		const storage = memoryStorage();
		const journal = new PersistenceJournal(
			storage,
			"pending-save.json",
			validateSnapshot,
			() => "next",
		);
		await journal.load();
		const manifestPath = "pending-save.manifest.json";
		const oldHead = storage.files.get(manifestPath);
		const originalRename = storage.rename;
		storage.rename = vi.fn(async (oldPath, newPath) => {
			if (oldPath.startsWith(`${manifestPath}.next-`)) throw new Error("promotion interrupted");
			await originalRename(oldPath, newPath);
		});

		await expect(journal.write({ revision: 1 })).rejects.toThrow("promotion interrupted");
		expect(storage.files.get(manifestPath)).toBe(oldHead);
	});
});
