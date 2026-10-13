import { describe, expect, it, vi } from "vitest";
import { copyFor, recordingSaveMessages } from "../src/i18n";
import {
	saveRecordingAndNotify,
	saveRecordingPayload,
	saveRecordingWithLink,
} from "../src/recording-save";

describe("saveRecordingWithLink", () => {
	it("reports complete success", async () => {
		const appendLink = vi.fn(async () => undefined);
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/voice.webm",
			saveAudio: async () => undefined,
			appendLink,
		});
		expect(outcome).toEqual({ status: "saved", audioPath: "Sonora/voice.webm" });
		expect(appendLink).toHaveBeenCalledWith("Sonora/voice.webm");
	});

	it("keeps the audio path when link insertion fails", async () => {
		const linkError = new Error("note changed");
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/orphan.webm",
			saveAudio: async () => undefined,
			appendLink: async () => {
				throw linkError;
			},
		});
		expect(outcome).toEqual({
			status: "audio-saved",
			audioPath: "Sonora/orphan.webm",
			linkError,
		});
	});

	it("does not append a link when audio creation fails", async () => {
		const saveError = new Error("disk full");
		const appendLink = vi.fn();
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/voice.webm",
			saveAudio: async () => {
				throw saveError;
			},
			appendLink,
		});
		expect(outcome).toEqual({ status: "failed", audioPath: null, saveError });
		expect(appendLink).not.toHaveBeenCalled();
	});

	it("durably prepares recovery before audio creation and clears it after success", async () => {
		const order: string[] = [];
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/voice.webm",
			saveAudio: async () => {
				order.push("audio");
			},
			prepareLink: async () => void order.push("prepare"),
			appendLink: async () => void order.push("append"),
			clearLinkIntent: async () => void order.push("clear"),
		});
		expect(outcome.status).toBe("saved");
		expect(order).toEqual(["prepare", "audio", "append", "clear"]);
	});

	it("never creates audio or appends when the recovery intent cannot be persisted", async () => {
		const saveAudio = vi.fn();
		const appendLink = vi.fn();
		const persistError = new Error("iCloud unavailable");
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/voice.webm",
			saveAudio,
			prepareLink: async () => {
				throw persistError;
			},
			appendLink,
		});
		expect(outcome).toEqual({
			status: "failed",
			audioPath: null,
			saveError: persistError,
		});
		expect(saveAudio).not.toHaveBeenCalled();
		expect(appendLink).not.toHaveBeenCalled();
	});

	it("clears the recovery intent when audio creation fails", async () => {
		const clearLinkIntent = vi.fn(async () => undefined);
		const saveError = new Error("disk full");
		const outcome = await saveRecordingWithLink({
			resolveAudioPath: () => "Sonora/voice.webm",
			saveAudio: async () => {
				throw saveError;
			},
			prepareLink: async () => undefined,
			appendLink: vi.fn(),
			clearLinkIntent,
		});

		expect(outcome).toEqual({ status: "failed", audioPath: null, saveError });
		expect(clearLinkIntent).toHaveBeenCalledWith("Sonora/voice.webm");
	});
});

describe("saveRecordingAndNotify", () => {
	it("connects partial success to a recoverable-path notice", async () => {
		const notify = vi.fn();
		const linkError = new Error("note changed");
		const outcome = await saveRecordingAndNotify(
			{
				resolveAudioPath: () => "Sonora/recover-me.webm",
				saveAudio: async () => undefined,
				appendLink: async () => {
					throw linkError;
				},
			},
			notify,
			{
				saved: "saved",
				failed: "failed",
				audioSaved: (path) => `recover:${path}`,
			},
		);

		expect(outcome).toEqual({
			status: "audio-saved",
			audioPath: "Sonora/recover-me.webm",
			linkError,
		});
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith("recover:Sonora/recover-me.webm");
	});
});

const fixedNow = new Date("2026-10-12T09:08:07.006Z");

function productionSaveHarness() {
	const order: string[] = [];
	const ensureFolder = vi.fn(async () => undefined);
	const createBinary = vi.fn(
		async (_path: string, _data: ArrayBuffer) => void order.push("create"),
	);
	const appendToSource = vi.fn(
		async (_sourcePath: string, _content: string) => void order.push("append"),
	);
	const preparePendingLink = vi.fn(
		async (_audioPath: string, _sourcePath: string) => void order.push("prepare"),
	);
	const clearPendingLink = vi.fn(
		async (_audioPath: string, _sourcePath: string) => void order.push("clear"),
	);
	const notify = vi.fn();
	return {
		order,
		ensureFolder,
		createBinary,
		appendToSource,
		preparePendingLink,
		clearPendingLink,
		notify,
		dependencies: {
			normalizePath: (path: string) => path.replaceAll("//", "/"),
			now: () => fixedNow,
			ensureFolder,
			createBinary,
			appendToSource,
			preparePendingLink,
			clearPendingLink,
		},
	};
}

function productionInput(appendVoiceMemoLink: boolean) {
	return {
		folder: "Sonora/Voice memos",
		title: "Source",
		sourcePath: "Notes/Source.md",
		blob: new Blob(["audio"], { type: "audio/webm" }),
		mimeType: "audio/webm",
		appendVoiceMemoLink,
	};
}

describe("saveRecordingPayload production path", () => {
	it("reuses an identical deterministic output without creating a duplicate", async () => {
		const harness = productionSaveHarness();
		const existing = await productionInput(false).blob.arrayBuffer();
		const outcome = await saveRecordingPayload(
			{ ...productionInput(false), outputPath: "Sonora/Voice memos/stable.webm" },
			{
				...harness.dependencies,
				exists: async () => true,
				readBinary: async () => existing,
			},
			harness.notify,
			recordingSaveMessages(copyFor("en", "en-US"), null),
		);
		expect(outcome).toMatchObject({ status: "saved", audioPath: "Sonora/Voice memos/stable.webm" });
		expect(harness.createBinary).not.toHaveBeenCalled();
	});

	it("fails closed when deterministic output content conflicts", async () => {
		const harness = productionSaveHarness();
		const outcome = await saveRecordingPayload(
			{ ...productionInput(false), outputPath: "Sonora/Voice memos/stable.webm" },
			{
				...harness.dependencies,
				exists: async () => true,
				readBinary: async () => new TextEncoder().encode("different").buffer,
			},
			harness.notify,
			recordingSaveMessages(copyFor("en", "en-US"), null),
		);
		expect(outcome.status).toBe("failed");
		expect(harness.createBinary).not.toHaveBeenCalled();
	});

	it("saves and links audio with an English success notice", async () => {
		const harness = productionSaveHarness();
		const outcome = await saveRecordingPayload(
			productionInput(true),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("en", "en-US"), null),
		);

		expect(outcome).toEqual({
			status: "saved",
			audioPath: "Sonora/Voice memos/Source 2026-10-12T09-08-07-006Z.webm",
		});
		expect(harness.ensureFolder).toHaveBeenCalledWith("Sonora/Voice memos");
		expect(harness.createBinary).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(["prepare", "create", "append", "clear"]);
		expect(harness.appendToSource).toHaveBeenCalledWith(
			"Notes/Source.md",
			expect.stringContaining("![[Sonora/Voice memos/Source 2026-10-12T09-08-07-006Z.webm]]"),
		);
		expect(harness.notify).toHaveBeenCalledWith("Voice response saved.");
	});

	it("skips source linking and localizes a limit notice in Japanese", async () => {
		const harness = productionSaveHarness();
		const outcome = await saveRecordingPayload(
			productionInput(false),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("ja", "ja-JP"), "size"),
		);

		expect(outcome.status).toBe("saved");
		expect(harness.appendToSource).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"録音サイズの上限に達したため、音声応答を保存した。",
		);
	});

	it("reports Japanese partial success with the recoverable path when linking fails", async () => {
		const harness = productionSaveHarness();
		harness.appendToSource.mockRejectedValueOnce(new Error("note changed"));
		const outcome = await saveRecordingPayload(
			productionInput(true),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("ja", "ja-JP"), null),
		);

		expect(outcome.status).toBe("audio-saved");
		expect(harness.notify).toHaveBeenCalledWith(
			"音声応答は「Sonora/Voice memos/Source 2026-10-12T09-08-07-006Z.webm」に保存したが、元ノートへのリンクは保留中。Sonoraが自動再試行するほか、リンク再試行コマンドも実行できる。",
		);
	});

	it("keeps a pre-created intent so restart recovery links audio after an immediate crash", async () => {
		const harness = productionSaveHarness();
		const pending = new Set<string>();
		const audio = new Set<string>();
		harness.dependencies.preparePendingLink = vi.fn(
			async (path: string, _sourcePath: string) => void pending.add(path),
		);
		harness.dependencies.createBinary = vi.fn(
			async (path: string, _data: ArrayBuffer) => void audio.add(path),
		);
		harness.dependencies.appendToSource = vi.fn(async (_sourcePath: string, _content: string) => {
			throw new Error("process interrupted after createBinary");
		});
		harness.dependencies.clearPendingLink = vi.fn(
			async (path: string, _sourcePath: string) => void pending.delete(path),
		);

		const outcome = await saveRecordingPayload(
			productionInput(true),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("en", "en-US"), null),
		);
		const path = "Sonora/Voice memos/Source 2026-10-12T09-08-07-006Z.webm";
		expect(outcome.status).toBe("audio-saved");
		expect(audio.has(path)).toBe(true);
		expect(pending.has(path)).toBe(true);

		// A restarted plugin sees both the durable intent and audio, then completes it.
		const restartAppend = vi.fn(async () => undefined);
		if (pending.has(path) && audio.has(path)) {
			await restartAppend();
			pending.delete(path);
		}
		expect(restartAppend).toHaveBeenCalledOnce();
		expect(pending.size).toBe(0);
	});

	it("does not create a binary when durable intent preparation fails", async () => {
		const harness = productionSaveHarness();
		harness.preparePendingLink.mockRejectedValueOnce(new Error("settings unavailable"));

		const outcome = await saveRecordingPayload(
			productionInput(true),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("en", "en-US"), null),
		);

		expect(outcome.status).toBe("failed");
		expect(harness.createBinary).not.toHaveBeenCalled();
		expect(harness.appendToSource).not.toHaveBeenCalled();
	});

	it("reports a localized total failure and never attempts linking", async () => {
		const harness = productionSaveHarness();
		harness.createBinary.mockRejectedValueOnce(new Error("disk full"));
		const outcome = await saveRecordingPayload(
			productionInput(true),
			harness.dependencies,
			harness.notify,
			recordingSaveMessages(copyFor("ja", "ja-JP"), null),
		);

		expect(outcome.status).toBe("failed");
		expect(harness.appendToSource).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			"録音を保存できなかった。保存先フォルダを確認してください。",
		);
	});
});
