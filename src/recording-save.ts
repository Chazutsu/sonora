export type RecordingSaveOutcome =
	| {
			readonly status: "saved";
			readonly audioPath: string;
	  }
	| {
			readonly status: "audio-saved";
			readonly audioPath: string;
			readonly linkError: unknown;
	  }
	| {
			readonly status: "failed";
			readonly audioPath: null;
			readonly saveError: unknown;
	  };

export interface RecordingSaveSteps {
	resolveAudioPath(): Promise<string> | string;
	saveAudio(audioPath: string): Promise<void>;
	prepareLink?(audioPath: string): Promise<void>;
	appendLink(audioPath: string): Promise<void>;
	clearLinkIntent?(audioPath: string): Promise<void>;
}

export interface RecordingSaveMessages {
	readonly saved: string;
	readonly failed: string;
	audioSaved(audioPath: string): string;
}

export interface RecordingFileSaveInput {
	readonly folder: string;
	readonly title: string;
	readonly sourcePath: string;
	readonly blob: Blob;
	readonly mimeType: string;
	readonly appendVoiceMemoLink: boolean;
	readonly outputPath?: string;
}

export interface RecordingFileSaveDependencies {
	normalizePath(path: string): string;
	now(): Date;
	ensureFolder(path: string): Promise<void>;
	createBinary(path: string, data: ArrayBuffer): Promise<unknown>;
	exists?(path: string): Promise<boolean>;
	readBinary?(path: string): Promise<ArrayBuffer>;
	appendToSource(sourcePath: string, content: string): Promise<void>;
	preparePendingLink?(audioPath: string, sourcePath: string): Promise<void>;
	clearPendingLink?(audioPath: string, sourcePath: string): Promise<void>;
}

/**
 * Preserves the important partial-success boundary: once the audio exists,
 * failure to append its note link must not be reported as a total failure.
 * The returned path can be placed in a recovery inbox or retried later.
 */
export async function saveRecordingWithLink(
	steps: RecordingSaveSteps,
): Promise<RecordingSaveOutcome> {
	let audioPath: string;
	try {
		audioPath = await steps.resolveAudioPath();
		await steps.prepareLink?.(audioPath);
	} catch (saveError) {
		return { status: "failed", audioPath: null, saveError };
	}

	try {
		await steps.saveAudio(audioPath);
	} catch (saveError) {
		try {
			await steps.clearLinkIntent?.(audioPath);
		} catch {
			// Keep the intent when cleanup cannot be persisted. Recovery ignores a
			// missing audio file, so it will never append a broken embed.
		}
		return { status: "failed", audioPath: null, saveError };
	}

	try {
		await steps.appendLink(audioPath);
		await steps.clearLinkIntent?.(audioPath);
		return { status: "saved", audioPath };
	} catch (linkError) {
		return { status: "audio-saved", audioPath, linkError };
	}
}

export async function saveRecordingAndNotify(
	steps: RecordingSaveSteps,
	notify: (message: string) => void,
	messages: RecordingSaveMessages,
): Promise<RecordingSaveOutcome> {
	const outcome = await saveRecordingWithLink(steps);
	if (outcome.status === "failed") notify(messages.failed);
	else if (outcome.status === "audio-saved") notify(messages.audioSaved(outcome.audioPath));
	else notify(messages.saved);
	return outcome;
}

export async function saveRecordingPayload(
	input: RecordingFileSaveInput,
	dependencies: RecordingFileSaveDependencies,
	notify: (message: string) => void,
	messages: RecordingSaveMessages,
): Promise<RecordingSaveOutcome> {
	const folder = dependencies.normalizePath(input.folder);
	return saveRecordingAndNotify(
		{
			resolveAudioPath: async () => {
				await dependencies.ensureFolder(folder);
				if (input.outputPath) return dependencies.normalizePath(input.outputPath);
				const stamp = dependencies.now().toISOString().replace(/[:.]/gu, "-");
				const extension = input.mimeType.includes("mp4")
					? "m4a"
					: input.mimeType.includes("ogg")
						? "ogg"
						: "webm";
				return dependencies.normalizePath(`${folder}/${input.title} ${stamp}.${extension}`);
			},
			saveAudio: async (path) => {
				const data = await input.blob.arrayBuffer();
				if (dependencies.exists && (await dependencies.exists(path))) {
					if (!dependencies.readBinary) throw new Error(`Recording output already exists: ${path}`);
					const existing = await dependencies.readBinary(path);
					if (!equalBytes(existing, data))
						throw new Error(`Recording output conflicts with existing content: ${path}`);
					return;
				}
				await dependencies.createBinary(path, data);
			},
			appendLink: async (path) => {
				if (!input.appendVoiceMemoLink) return;
				await dependencies.appendToSource(
					input.sourcePath,
					`\n\n<!-- sonora-voice-response:start -->\n> [!note] Sonora voice response\n> ![[${path}]]\n<!-- sonora-voice-response:end -->\n`,
				);
			},
			prepareLink: async (path) => {
				if (!input.appendVoiceMemoLink) return;
				await dependencies.preparePendingLink?.(path, input.sourcePath);
			},
			clearLinkIntent: async (path) => {
				if (!input.appendVoiceMemoLink) return;
				await dependencies.clearPendingLink?.(path, input.sourcePath);
			},
		},
		notify,
		messages,
	);
}

export function recordingOutputPath(
	folder: string,
	title: string,
	mimeType: string,
	startedAt: number,
	normalizePath: (path: string) => string,
): string {
	const stamp = new Date(startedAt).toISOString().replace(/[:.]/gu, "-");
	const extension = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
	return normalizePath(`${folder}/${title} ${stamp}.${extension}`);
}

function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	for (let index = 0; index < leftBytes.length; index += 1)
		if (leftBytes[index] !== rightBytes[index]) return false;
	return true;
}
