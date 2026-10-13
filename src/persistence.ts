import {
	DEFAULT_SETTINGS,
	type QueueItem,
	type ReadonlyQueueItem,
	type PendingVoiceMemoLink,
	type SonoraData,
	type SonoraSettings,
	type StoredQueueItem,
	type StoredSonoraData,
} from "./types";

type ReadonlySonoraData = Omit<
	Readonly<SonoraData>,
	"settings" | "queue" | "pendingVoiceMemoLinks"
> & {
	readonly settings: Readonly<SonoraSettings>;
	readonly queue: readonly ReadonlyQueueItem[];
	readonly pendingVoiceMemoLinks: readonly Readonly<PendingVoiceMemoLink>[];
};

export const CURRENT_SCHEMA_VERSION = 4;
export const MAX_PENDING_VOICE_MEMO_LINKS = 100;

export function sameVaultPath(left: string, right: string): boolean {
	return left.normalize("NFC") === right.normalize("NFC");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;

const boundedNumber = (value: unknown, minimum: number, maximum: number, fallback: number) =>
	isFiniteNumber(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;

function deserializeSettings(value: unknown): SonoraSettings {
	const settings = isRecord(value) ? value : {};
	return {
		interfaceLanguage: oneOf(
			settings.interfaceLanguage,
			["system", "en", "ja"] as const,
			DEFAULT_SETTINGS.interfaceLanguage,
		),
		language: oneOf(
			settings.language,
			["system", "en-US", "ja-JP"] as const,
			DEFAULT_SETTINGS.language,
		),
		rate: boundedNumber(settings.rate, 0.5, 3, DEFAULT_SETTINGS.rate),
		pitch: boundedNumber(settings.pitch, 0.5, 2, DEFAULT_SETTINGS.pitch),
		voiceName: isString(settings.voiceName) ? settings.voiceName : DEFAULT_SETTINGS.voiceName,
		recordingFolder:
			isString(settings.recordingFolder) && settings.recordingFolder.trim()
				? settings.recordingFolder
				: DEFAULT_SETTINGS.recordingFolder,
		appendVoiceMemoLink:
			typeof settings.appendVoiceMemoLink === "boolean"
				? settings.appendVoiceMemoLink
				: DEFAULT_SETTINGS.appendVoiceMemoLink,
		recallDelaySeconds: boundedNumber(
			settings.recallDelaySeconds,
			1,
			10,
			DEFAULT_SETTINGS.recallDelaySeconds,
		),
	};
}

function storedQueueItem(value: unknown): StoredQueueItem | null {
	if (!isRecord(value)) return null;
	if (!isString(value.id) || !isString(value.path) || !isString(value.title)) return null;
	return {
		id: value.id,
		path: value.path,
		title: value.title,
		chapterIndex: isFiniteNumber(value.chapterIndex)
			? Math.max(0, Math.floor(value.chapterIndex))
			: 0,
		completed: value.completed === true,
		addedAt: isFiniteNumber(value.addedAt) ? value.addedAt : Date.now(),
		lastPlayedAt:
			isFiniteNumber(value.lastPlayedAt) && value.lastPlayedAt >= 0
				? value.lastPlayedAt
				: undefined,
		kind: value.kind === "drill" ? "drill" : "note",
		loop: value.loop === true,
	};
}

function pendingVoiceMemoLink(value: unknown): PendingVoiceMemoLink | null {
	if (!isRecord(value)) return null;
	if (!isString(value.audioPath) || !value.audioPath.trim()) return null;
	if (!isString(value.sourcePath) || !value.sourcePath.trim()) return null;
	if (!isFiniteNumber(value.createdAt) || value.createdAt < 0) return null;
	return {
		audioPath: value.audioPath,
		sourcePath: value.sourcePath,
		createdAt: value.createdAt,
	};
}

export function deserializePendingVoiceMemoLinks(value: unknown): PendingVoiceMemoLink[] {
	if (!Array.isArray(value)) return [];
	const unique = new Map<string, PendingVoiceMemoLink>();
	for (const item of value) {
		const pending = pendingVoiceMemoLink(item);
		if (!pending) continue;
		const key = `${pending.audioPath.normalize("NFC")}\u0000${pending.sourcePath.normalize("NFC")}`;
		unique.set(key, pending);
	}
	return [...unique.values()]
		.toSorted(
			(left: Readonly<PendingVoiceMemoLink>, right: Readonly<PendingVoiceMemoLink>) =>
				left.createdAt - right.createdAt,
		)
		.slice(-MAX_PENDING_VOICE_MEMO_LINKS);
}

export function deserializeData(value: unknown): SonoraData {
	const input = isRecord(value) ? value : {};
	const queue = Array.isArray(input.queue)
		? input.queue.flatMap((item) => {
				const stored = storedQueueItem(item);
				if (!stored) return [];
				const legacyChapters =
					isRecord(item) && Array.isArray(item.chapters)
						? (item.chapters as QueueItem["chapters"])
						: [];
				return [{ ...stored, chapters: legacyChapters }];
			})
		: [];
	const activeItemId = isString(input.activeItemId) ? input.activeItemId : null;
	const resolvedActiveItemId = queue.some((item: ReadonlyQueueItem) => item.id === activeItemId)
		? activeItemId
		: (queue[0]?.id ?? null);
	const upNextItemId = isString(input.upNextItemId) ? input.upNextItemId : null;
	return {
		settings: deserializeSettings(input.settings),
		queue,
		activeItemId: resolvedActiveItemId,
		upNextItemId:
			upNextItemId !== resolvedActiveItemId &&
			queue.some((item: ReadonlyQueueItem) => item.id === upNextItemId && !item.completed)
				? upNextItemId
				: null,
		pendingVoiceMemoLinks: deserializePendingVoiceMemoLinks(input.pendingVoiceMemoLinks),
	};
}

export function deserializePersistenceWatermark(
	value: unknown,
): StoredSonoraData["persistenceWatermark"] {
	if (!isRecord(value) || !isRecord(value.persistenceWatermark)) return undefined;
	const watermark = value.persistenceWatermark;
	if (!isString(watermark.manifestId) || !watermark.manifestId) return undefined;
	if (!isFiniteNumber(watermark.committedSequence)) return undefined;
	const committedSequence = Math.floor(watermark.committedSequence);
	if (committedSequence < 0) return undefined;
	return { manifestId: watermark.manifestId, committedSequence };
}

export function serializeData(data: ReadonlySonoraData): StoredSonoraData {
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		settings: { ...data.settings },
		queue: data.queue.map(
			({
				chapters: _chapters,
				unavailable: _unavailable,
				loadError: _loadError,
				...item
			}): StoredQueueItem => item,
		),
		activeItemId: data.activeItemId,
		upNextItemId: data.upNextItemId,
		pendingVoiceMemoLinks: data.pendingVoiceMemoLinks.map(
			(pending: Readonly<PendingVoiceMemoLink>) => ({ ...pending }),
		),
	};
}
