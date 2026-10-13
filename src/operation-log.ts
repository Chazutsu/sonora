import { DEFAULT_SETTINGS, type StoredQueueItem, type StoredSonoraData } from "./types";
import { deserializePendingVoiceMemoLinks } from "./persistence";

export const OPERATION_LOG_SCHEMA_VERSION = 2;
export const SONORA_ROOT_ENTITY_ID = "sonora";
export const SONORA_SETTINGS_ENTITY_ID = "settings";
export const QUEUE_ENTITY_PREFIX = "queue/";
export const ENTITY_TOMBSTONE_FIELD = "*";

export type OperationValue = string | number | boolean | null;

export type SonoraOperation = {
	operationId: string;
	deviceId: string;
	entityId: string;
	field: string;
	value: OperationValue;
	timestamp: number;
	tombstone?: boolean;
};

export type OperationLogDocument = {
	schemaVersion: typeof OPERATION_LOG_SCHEMA_VERSION;
	deviceId: string;
	clock: number;
	operations: SonoraOperation[];
};

type ReadonlySonoraOperation = Readonly<SonoraOperation>;
type ReadonlyOperationLogDocument = Omit<Readonly<OperationLogDocument>, "operations"> & {
	readonly operations: readonly ReadonlySonoraOperation[];
};
type ReadonlyStoredSonoraData = Omit<
	Readonly<StoredSonoraData>,
	"settings" | "queue" | "pendingVoiceMemoLinks" | "persistenceWatermark"
> & {
	readonly settings: Readonly<StoredSonoraData["settings"]>;
	readonly queue: readonly Readonly<StoredQueueItem>[];
	readonly pendingVoiceMemoLinks: readonly Readonly<
		StoredSonoraData["pendingVoiceMemoLinks"][number]
	>[];
	readonly persistenceWatermark?: Readonly<NonNullable<StoredSonoraData["persistenceWatermark"]>>;
};

const QUEUE_FIELDS = [
	"id",
	"path",
	"title",
	"chapterIndex",
	"completed",
	"addedAt",
	"kind",
	"loop",
] as const satisfies readonly (keyof StoredQueueItem)[];

const SETTINGS_FIELDS = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];

const queueEntityId = (id: string) => `${QUEUE_ENTITY_PREFIX}${encodeURIComponent(id)}`;

const canonicalOperation = (operation: ReadonlySonoraOperation) =>
	JSON.stringify([
		operation.timestamp,
		operation.deviceId,
		operation.operationId,
		operation.entityId,
		operation.field,
		operation.tombstone === true,
		operation.value,
	]);

/** Total ordering used for every conflict, including equal logical timestamps. */
export function compareOperations(
	left: ReadonlySonoraOperation,
	right: ReadonlySonoraOperation,
): number {
	if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
	const byDevice = left.deviceId.localeCompare(right.deviceId);
	if (byDevice !== 0) return byDevice;
	const byId = left.operationId.localeCompare(right.operationId);
	if (byId !== 0) return byId;
	return canonicalOperation(left).localeCompare(canonicalOperation(right));
}

function later<T extends ReadonlySonoraOperation>(left: T | undefined, right: T): T {
	return !left || compareOperations(left, right) < 0 ? right : left;
}

/** Merges device logs without depending on file read order. */
export function mergeOperations<T extends ReadonlySonoraOperation>(
	...logs: readonly (readonly T[])[]
): T[] {
	const byOperationId = new Map<string, T>();
	for (const operation of logs.flat()) {
		const existing = byOperationId.get(operation.operationId);
		byOperationId.set(operation.operationId, later(existing, operation));
	}
	return [...byOperationId.values()].toSorted(compareOperations);
}

function isAfterEntityTombstone(
	operation: ReadonlySonoraOperation | undefined,
	tombstone: ReadonlySonoraOperation | undefined,
): operation is ReadonlySonoraOperation {
	return Boolean(operation && (!tombstone || compareOperations(tombstone, operation) < 0));
}

function valueOf(
	fields: Readonly<Pick<ReadonlyMap<string, ReadonlySonoraOperation>, "get">>,
	field: string,
	fallback: OperationValue,
): OperationValue {
	const operation = fields.get(field);
	return operation !== undefined && operation.tombstone !== true ? operation.value : fallback;
}

/** Reduces an unordered log into the same snapshot on every device. */
export function reduceOperations(operations: readonly ReadonlySonoraOperation[]): StoredSonoraData {
	const fieldsByEntity = new Map<string, Map<string, ReadonlySonoraOperation>>();
	for (const operation of mergeOperations([...operations])) {
		const fields =
			fieldsByEntity.get(operation.entityId) ?? new Map<string, ReadonlySonoraOperation>();
		fields.set(operation.field, later(fields.get(operation.field), operation));
		fieldsByEntity.set(operation.entityId, fields);
	}

	const settingsFields = fieldsByEntity.get(SONORA_SETTINGS_ENTITY_ID) ?? new Map();
	const settings = { ...DEFAULT_SETTINGS };
	for (const field of SETTINGS_FIELDS) {
		const operation = settingsFields.get(field);
		if (operation !== undefined && operation.tombstone !== true) {
			(settings as Record<string, OperationValue>)[field] = operation.value;
		}
	}

	const queue: StoredQueueItem[] = [];
	for (const [entityId, fields] of fieldsByEntity) {
		if (!entityId.startsWith(QUEUE_ENTITY_PREFIX)) continue;
		const entityTombstone = fields.get(ENTITY_TOMBSTONE_FIELD);
		const liveFields = new Map(
			[...fields].filter((entry: readonly [string, ReadonlySonoraOperation]) =>
				isAfterEntityTombstone(entry[1], entityTombstone),
			),
		);
		const id = valueOf(
			liveFields,
			"id",
			decodeURIComponent(entityId.slice(QUEUE_ENTITY_PREFIX.length)),
		);
		const path = valueOf(liveFields, "path", "");
		const title = valueOf(liveFields, "title", "");
		if (typeof id !== "string" || typeof path !== "string" || typeof title !== "string" || !path) {
			continue;
		}
		queue.push({
			id,
			path,
			title,
			chapterIndex: Math.max(0, Math.floor(Number(valueOf(liveFields, "chapterIndex", 0)) || 0)),
			completed: valueOf(liveFields, "completed", false) === true,
			addedAt: Number(valueOf(liveFields, "addedAt", 0)) || 0,
			kind: valueOf(liveFields, "kind", "note") === "drill" ? "drill" : "note",
			loop: valueOf(liveFields, "loop", false) === true,
		});
	}
	queue.sort(
		(left: Readonly<StoredQueueItem>, right: Readonly<StoredQueueItem>) =>
			left.addedAt - right.addedAt || left.id.localeCompare(right.id),
	);

	const rootFields = fieldsByEntity.get(SONORA_ROOT_ENTITY_ID) ?? new Map();
	const storedActive = valueOf(rootFields, "activeItemId", null);
	const activeItemId =
		typeof storedActive === "string" &&
		queue.some((item: Readonly<StoredQueueItem>) => item.id === storedActive)
			? storedActive
			: (queue[0]?.id ?? null);
	const storedUpNext = valueOf(rootFields, "upNextItemId", null);
	const upNextItemId =
		typeof storedUpNext === "string" &&
		storedUpNext !== activeItemId &&
		queue.some((item: Readonly<StoredQueueItem>) => item.id === storedUpNext && !item.completed)
			? storedUpNext
			: null;
	const pendingValue = valueOf(rootFields, "pendingVoiceMemoLinks", "[]");
	let pendingVoiceMemoLinks: StoredSonoraData["pendingVoiceMemoLinks"] = [];
	if (typeof pendingValue === "string") {
		try {
			pendingVoiceMemoLinks = deserializePendingVoiceMemoLinks(JSON.parse(pendingValue));
		} catch {
			// Malformed journal data must not prevent queue recovery.
		}
	}

	return {
		schemaVersion: OPERATION_LOG_SCHEMA_VERSION,
		settings,
		queue,
		activeItemId,
		upNextItemId,
		pendingVoiceMemoLinks,
	};
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

type OperationWriter = (
	entityId: string,
	field: string,
	value: OperationValue,
	tombstone?: boolean,
) => void;

function snapshotDiff(
	previous: ReadonlyStoredSonoraData | null,
	next: ReadonlyStoredSonoraData,
	write: OperationWriter,
) {
	for (const field of SETTINGS_FIELDS) {
		if (!previous || !equal(previous.settings[field], next.settings[field])) {
			write(SONORA_SETTINGS_ENTITY_ID, field, next.settings[field]);
		}
	}
	if (previous?.activeItemId !== next.activeItemId) {
		write(SONORA_ROOT_ENTITY_ID, "activeItemId", next.activeItemId);
	}
	if (!previous || (previous.upNextItemId ?? null) !== (next.upNextItemId ?? null)) {
		write(SONORA_ROOT_ENTITY_ID, "upNextItemId", next.upNextItemId ?? null);
	}
	if (!previous || !equal(previous.pendingVoiceMemoLinks, next.pendingVoiceMemoLinks)) {
		write(
			SONORA_ROOT_ENTITY_ID,
			"pendingVoiceMemoLinks",
			JSON.stringify(next.pendingVoiceMemoLinks),
		);
	}

	const previousItems = new Map(previous?.queue.map((item) => [item.id, item]) ?? []);
	const nextItems = new Map(next.queue.map((item) => [item.id, item]));
	for (const [id, item] of nextItems) {
		const old = previousItems.get(id);
		for (const field of QUEUE_FIELDS) {
			const value = item[field] ?? null;
			if (!old || !equal(old[field], value)) write(queueEntityId(id), field, value);
		}
	}
	for (const id of previousItems.keys()) {
		if (!nextItems.has(id)) write(queueEntityId(id), ENTITY_TOMBSTONE_FIELD, null, true);
	}
}

export function createOperationLog(deviceId: string): OperationLogDocument {
	return { schemaVersion: OPERATION_LOG_SCHEMA_VERSION, deviceId, clock: 0, operations: [] };
}

/** Converts the legacy snapshot to a device log. Safe to call once during migration. */
export function migrateStoredData(
	snapshot: ReadonlyStoredSonoraData,
	deviceId: string,
): OperationLogDocument {
	return appendSnapshot(createOperationLog(deviceId), snapshot);
}

/** Appends only changed fields and advances a Lamport-style device-local clock. */
export function appendSnapshot(
	document: ReadonlyOperationLogDocument,
	snapshot: ReadonlyStoredSonoraData,
): OperationLogDocument {
	const operations = [...document.operations];
	let clock = Math.max(document.clock, ...operations.map((operation) => operation.timestamp), 0);
	let sequence = operations.length;
	const write: OperationWriter = (entityId, field, value, tombstone) => {
		clock += 1;
		sequence += 1;
		operations.push({
			operationId: `${document.deviceId}:${clock}:${sequence}`,
			deviceId: document.deviceId,
			entityId,
			field,
			value,
			timestamp: clock,
			...(tombstone === true ? { tombstone: true } : {}),
		});
	};
	const previous = document.operations.length ? reduceOperations(document.operations) : null;
	snapshotDiff(previous, snapshot, write);
	return { ...document, schemaVersion: OPERATION_LOG_SCHEMA_VERSION, clock, operations };
}
