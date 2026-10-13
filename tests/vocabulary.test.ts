import { describe, expect, it } from "vitest";
import { vocabularyChapters, vocabularyFromMarkdown } from "../src/vocabulary";

describe("vocabulary notes", () => {
	it("parses English and Japanese field labels", () => {
		const cards = vocabularyFromMarkdown(`## resilient
- meaning: 回復力がある
- pronunciation: /rɪˈzɪliənt/
- example: The system is resilient.

## compose
- 意味: 構成する
- 例文: Compose an episode.`);
		expect(cards).toHaveLength(2);
		expect(cards[0]).toEqual({
			term: "resilient",
			meaning: "回復力がある",
			pronunciation: "/rɪˈzɪliənt/",
			example: "The system is resilient.",
		});
		expect(vocabularyChapters(cards)[1]).toEqual({
			heading: "compose",
			level: 2,
			text: "構成する. Compose an episode.",
		});
	});

	it("ignores headings without a meaning", () => {
		expect(vocabularyFromMarkdown("## incomplete\n- example: Missing meaning")).toEqual([]);
	});
});
