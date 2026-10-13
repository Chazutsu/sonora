import { describe, expect, it } from "vitest";
import {
	addPendingVoiceMemoLink,
	hasVoiceMemoLink,
	removePendingVoiceMemoLink,
	renamePendingVoiceMemoPaths,
	voiceMemoLinkContent,
} from "../src/voice-memo-journal";
import type { PendingVoiceMemoLink } from "../src/types";

describe("voice memo recovery journal", () => {
	it("deduplicates intents and keeps the newest 100", () => {
		let pending: PendingVoiceMemoLink[] = [];
		for (let index = 0; index < 101; index += 1) {
			pending = addPendingVoiceMemoLink(pending, {
				audioPath: `Audio/${index}.webm`,
				sourcePath: "Notes/source.md",
				createdAt: index,
			});
		}
		pending = addPendingVoiceMemoLink(pending, {
			audioPath: "Audio/100.webm",
			sourcePath: "Notes/source.md",
			createdAt: 999,
		});

		expect(pending).toHaveLength(100);
		expect(pending[0]?.audioPath).toBe("Audio/1.webm");
		expect(pending.at(-1)?.createdAt).toBe(999);
	});

	it("follows source and audio renames and removes only the matching intent", () => {
		const initial = [
			{ audioPath: "Audio/a.webm", sourcePath: "Notes/a.md", createdAt: 1 },
			{ audioPath: "Audio/b.webm", sourcePath: "Notes/b.md", createdAt: 2 },
		];
		const sourceRenamed = renamePendingVoiceMemoPaths(initial, "Notes/a.md", "Notes/new.md");
		const audioRenamed = renamePendingVoiceMemoPaths(
			sourceRenamed,
			"Audio/a.webm",
			"Audio/new.webm",
		);
		expect(audioRenamed[0]).toMatchObject({
			audioPath: "Audio/new.webm",
			sourcePath: "Notes/new.md",
		});
		expect(removePendingVoiceMemoLink(audioRenamed, "Audio/new.webm", "Notes/new.md")).toEqual([
			initial[1],
		]);
	});

	it("detects an existing exact embed before retrying", () => {
		const content = voiceMemoLinkContent("Audio/a.webm");
		expect(hasVoiceMemoLink(content, "Audio/a.webm")).toBe(true);
		expect(hasVoiceMemoLink(content, "Audio/b.webm")).toBe(false);
	});
});
