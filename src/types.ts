export type Chapter = {
	heading: string;
	level: number;
	text: string;
};

export type QueueItem = {
	id: string;
	path: string;
	title: string;
	chapters: Chapter[];
	chapterIndex: number;
	completed: boolean;
	addedAt: number;
	lastPlayedAt?: number;
	/** Resolved at runtime from frontmatter or the first image; never persisted. */
	coverUrl?: string;
	kind?: "note" | "drill";
	loop?: boolean;
	unavailable?: boolean;
	/** The source exists but could not be read during queue hydration. */
	loadError?: boolean;
};

export type SonoraSettings = {
	interfaceLanguage: "system" | "en" | "ja";
	language: "system" | "en-US" | "ja-JP";
	rate: number;
	pitch: number;
	voiceName: string;
	recordingFolder: string;
	appendVoiceMemoLink: boolean;
	recallDelaySeconds: number;
};

export type PendingVoiceMemoLink = {
	audioPath: string;
	sourcePath: string;
	createdAt: number;
};

export type SonoraData = {
	settings: SonoraSettings;
	queue: QueueItem[];
	activeItemId: string | null;
	upNextItemId: string | null;
	pendingVoiceMemoLinks: PendingVoiceMemoLink[];
};

export type StoredQueueItem = Omit<
	QueueItem,
	"chapters" | "unavailable" | "loadError" | "coverUrl"
>;

export type StoredSonoraData = {
	schemaVersion: number;
	settings: SonoraSettings;
	queue: StoredQueueItem[];
	activeItemId: string | null;
	upNextItemId?: string | null;
	pendingVoiceMemoLinks: PendingVoiceMemoLink[];
	persistenceWatermark?: { manifestId: string; committedSequence: number };
};

export const DEFAULT_SETTINGS: SonoraSettings = {
	interfaceLanguage: "system",
	language: "system",
	rate: 0.9,
	pitch: 1,
	voiceName: "",
	recordingFolder: "Sonora/Voice memos",
	appendVoiceMemoLink: true,
	recallDelaySeconds: 3,
};
