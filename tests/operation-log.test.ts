import { describe, expect, it } from "vitest";
import {
	ENTITY_TOMBSTONE_FIELD,
	appendSnapshot,
	mergeOperations,
	migrateStoredData,
	reduceOperations,
	type SonoraOperation,
} from "../src/operation-log";
import { DEFAULT_SETTINGS, type StoredSonoraData } from "../src/types";

const snapshot = (overrides: Partial<StoredSonoraData> = {}): StoredSonoraData => ({
	schemaVersion: 1,
	settings: { ...DEFAULT_SETTINGS },
	queue: [
		{
			id: "a",
			path: "Notes/A.md",
			title: "A",
			chapterIndex: 0,
			completed: false,
			addedAt: 1,
			kind: "note",
			loop: false,
		},
	],
	activeItemId: "a",
	pendingVoiceMemoLinks: [],
	...overrides,
});

describe("operation log", () => {
	it("migrates a legacy snapshot without losing data", () => {
		const reduced = reduceOperations(migrateStoredData(snapshot(), "mac").operations);
		expect(reduced).toMatchObject({
			settings: DEFAULT_SETTINGS,
			queue: snapshot().queue,
			activeItemId: "a",
		});
	});

	it("converges regardless of device and read order", () => {
		const base = migrateStoredData(snapshot(), "mac");
		const iphone = appendSnapshot(
			{ ...base, deviceId: "iphone" },
			snapshot({ queue: [{ ...snapshot().queue[0]!, completed: true }] }),
		);
		const ipad = appendSnapshot(
			{ ...base, deviceId: "ipad" },
			snapshot({ queue: [{ ...snapshot().queue[0]!, chapterIndex: 2 }] }),
		);
		const left = reduceOperations(
			mergeOperations(base.operations, iphone.operations, ipad.operations),
		);
		const right = reduceOperations(
			mergeOperations(ipad.operations, base.operations, iphone.operations),
		);
		expect(left).toEqual(right);
		expect(left.queue[0]).toMatchObject({ completed: true, chapterIndex: 2 });
	});

	it("uses device and operation ids to break equal timestamp ties", () => {
		const operations: SonoraOperation[] = [
			{
				operationId: "1",
				deviceId: "a",
				entityId: "settings",
				field: "rate",
				value: 1,
				timestamp: 4,
			},
			{
				operationId: "1",
				deviceId: "z",
				entityId: "settings",
				field: "rate",
				value: 2,
				timestamp: 4,
			},
		];
		expect(reduceOperations(operations).settings.rate).toBe(2);
		expect(reduceOperations(operations.toReversed()).settings.rate).toBe(2);
	});

	it("keeps deletions as tombstones and permits a later resurrection", () => {
		const migrated = migrateStoredData(snapshot(), "mac");
		const removed = appendSnapshot(migrated, snapshot({ queue: [], activeItemId: null }));
		expect(removed.operations.at(-1)).toMatchObject({
			field: ENTITY_TOMBSTONE_FIELD,
			tombstone: true,
		});
		expect(reduceOperations(removed.operations).queue).toEqual([]);

		const restored = appendSnapshot(removed, snapshot());
		expect(reduceOperations(restored.operations).queue).toEqual(snapshot().queue);
	});

	it("does not append operations for an unchanged snapshot", () => {
		const migrated = migrateStoredData(snapshot(), "mac");
		expect(appendSnapshot(migrated, snapshot()).operations).toHaveLength(
			migrated.operations.length,
		);
	});

	it("round-trips the pending voice memo recovery journal", () => {
		const pendingVoiceMemoLinks = [
			{ audioPath: "Audio/a.webm", sourcePath: "Notes/a.md", createdAt: 1 },
		];
		const migrated = migrateStoredData(snapshot({ pendingVoiceMemoLinks }), "mac");
		expect(reduceOperations(migrated.operations).pendingVoiceMemoLinks).toEqual(
			pendingVoiceMemoLinks,
		);
	});
});
