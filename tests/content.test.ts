import { describe, expect, it } from "vitest";
import {
	chaptersFromMarkdown,
	coverReferenceFromMarkdown,
	readableMarkdown,
	splitForSpeech,
} from "../src/content";

describe("coverReferenceFromMarkdown", () => {
	it("frontmatter画像を本文画像より優先する", () => {
		expect(
			coverReferenceFromMarkdown(
				'---\ncover: "[[assets/show.webp]]"\n---\n![body](assets/body.png)',
			),
		).toBe("assets/show.webp");
	});

	it("frontmatterがなければ先頭のMarkdown画像か埋め込み画像を使う", () => {
		expect(coverReferenceFromMarkdown("Intro\n![cover](assets/first.jpg)\n![[later.png]]")).toBe(
			"assets/first.jpg",
		);
		expect(coverReferenceFromMarkdown("Intro\n![[assets/cover.png|240]]")).toBe("assets/cover.png");
	});

	it("画像がなければnullを返す", () => {
		expect(coverReferenceFromMarkdown("# Plain note\nText")).toBeNull();
	});
});

describe("readableMarkdown", () => {
	it("removes syntax while preserving readable labels", () => {
		expect(
			readableMarkdown(
				"---\ntags: [test]\n---\n- **Read** [[Note|this note]] and [source](https://example.com).",
			),
		).toBe("Read this note and source.");
	});

	it("never reads hidden Obsidian and generated-region comments", () => {
		expect(
			readableMarkdown(
				"Before.\n<!-- related-notes:start -->\nHidden relation.\n<!-- related-notes:end -->\n%%private%%\nAfter.",
			),
		).toBe("Before. After.");
		expect(readableMarkdown("Before. <!-- generated metadata --> After.")).toBe("Before. After.");
		expect(
			readableMarkdown(
				"Before.\n<!-- sonora-voice-response:start -->\n> ![[Sonora/response.webm]]\n<!-- sonora-voice-response:end -->\nAfter.",
			),
		).toBe("Before. After.");
	});
});

describe("chaptersFromMarkdown", () => {
	it("creates a chapter for the introduction and every non-empty heading", () => {
		expect(
			chaptersFromMarkdown("Opening.\n## First\nAlpha.\n### Second\nBeta.", "Example"),
		).toEqual([
			{ heading: "Example", level: 1, text: "Opening." },
			{ heading: "First", level: 2, text: "Alpha." },
			{ heading: "Second", level: 3, text: "Beta." },
		]);
	});

	it("keeps a heading-free note playable", () => {
		expect(chaptersFromMarkdown("Only text", "Example")).toEqual([
			{ heading: "Example", level: 1, text: "Only text" },
		]);
	});
});

describe("splitForSpeech", () => {
	it("chunks long text without losing content", () => {
		const input = "First sentence. Second sentence. Third sentence.";
		const chunks = splitForSpeech(input, 25);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.join("")).toBe(input);
	});
});
