import { describe, expect, it } from "vitest";
import { deserializeData, sameVaultPath, serializeData } from "../src/persistence";
import { DEFAULT_SETTINGS, type SonoraData } from "../src/types";

describe("Sonora persistence", () => {
	it("migrates legacy queue data while preserving progress", () => {
		const data = deserializeData({
			settings: { rate: 1.25 },
			activeItemId: "one",
			upNextItemId: null,
			queue: [
				{
					id: "one",
					path: "Notes/One.md",
					title: "One",
					chapterIndex: 2,
					completed: false,
					addedAt: 1,
					chapters: [{ heading: "Private", level: 1, text: "Legacy body" }],
				},
			],
		});
		expect(data.settings.rate).toBe(1.25);
		expect(data.settings.pitch).toBe(DEFAULT_SETTINGS.pitch);
		expect(data.queue[0]?.chapters[0]?.text).toBe("Legacy body");
	});

	it("never persists note bodies or transient availability", () => {
		const data: SonoraData = {
			settings: DEFAULT_SETTINGS,
			activeItemId: "one",
			upNextItemId: null,
			pendingVoiceMemoLinks: [],
			queue: [
				{
					id: "one",
					path: "Notes/One.md",
					title: "One",
					chapterIndex: 0,
					completed: false,
					addedAt: 1,
					kind: "note",
					unavailable: true,
					chapters: [{ heading: "Secret", level: 1, text: "Must not persist" }],
				},
			],
		};
		const stored = serializeData(data);
		expect(stored.schemaVersion).toBe(4);
		expect(stored.queue[0]).not.toHaveProperty("chapters");
		expect(stored.queue[0]).not.toHaveProperty("unavailable");
		expect(JSON.stringify(stored)).not.toContain("Must not persist");
	});

	it("repairs malformed queue entries and active ids", () => {
		const data = deserializeData({ queue: [{ id: 42 }], activeItemId: "missing" });
		expect(data.queue).toEqual([]);
		expect(data.activeItemId).toBeNull();
	});

	it("persists a valid Up Next choice and clears stale or active choices", () => {
		const queue = [
			{ id: "one", path: "One.md", title: "One", chapterIndex: 0, completed: false, addedAt: 1 },
			{ id: "two", path: "Two.md", title: "Two", chapterIndex: 0, completed: false, addedAt: 2 },
		];
		expect(deserializeData({ queue, activeItemId: "one", upNextItemId: "two" }).upNextItemId).toBe(
			"two",
		);
		expect(
			deserializeData({ queue, activeItemId: "one", upNextItemId: "one" }).upNextItemId,
		).toBeNull();
		expect(
			deserializeData({ queue, activeItemId: "one", upNextItemId: "missing" }).upNextItemId,
		).toBeNull();
		expect(
			deserializeData({
				queue: [queue[0], { ...queue[1], completed: true }],
				activeItemId: "one",
				upNextItemId: "two",
			}).upNextItemId,
		).toBeNull();
	});

	it("repairs, deduplicates, and bounds pending voice memo links", () => {
		const pendingVoiceMemoLinks = Array.from({ length: 102 }, (_, index) => ({
			audioPath: `Audio/${index}.webm`,
			sourcePath: "Notes/source.md",
			createdAt: index,
		}));
		pendingVoiceMemoLinks.push(pendingVoiceMemoLinks.at(-1)!);
		pendingVoiceMemoLinks.push({ audioPath: "", sourcePath: "Notes/source.md", createdAt: 999 });
		const data = deserializeData({ pendingVoiceMemoLinks });
		expect(data.pendingVoiceMemoLinks).toHaveLength(100);
		expect(data.pendingVoiceMemoLinks[0]?.audioPath).toBe("Audio/2.webm");
		expect(data.pendingVoiceMemoLinks.at(-1)?.audioPath).toBe("Audio/101.webm");
	});

	it("repairs malformed and out-of-range settings", () => {
		const data = deserializeData({
			settings: {
				interfaceLanguage: "xx",
				language: 42,
				rate: 99,
				pitch: -1,
				voiceName: false,
				recordingFolder: "   ",
				appendVoiceMemoLink: "yes",
				recallDelaySeconds: 0,
			},
		});
		expect(data.settings).toEqual({
			...DEFAULT_SETTINGS,
			rate: 3,
			pitch: 0.5,
			recallDelaySeconds: 1,
		});
	});

	it("matches iCloud paths across Unicode composition forms", () => {
		expect(sameVaultPath("private/解決では.md", "private/解決て\u3099は.md")).toBe(true);
	});
});
