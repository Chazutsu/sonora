import { describe, expect, it } from "vitest";
import { continueListening, queueSections } from "../src/playback-information";
import type { QueueItem } from "../src/types";

const item = (id: string, lastPlayedAt?: number, completed = false): QueueItem => ({
	id,
	path: `${id}.md`,
	title: id,
	chapters: [{ heading: "章", level: 2, text: "本文" }],
	chapterIndex: 0,
	completed,
	addedAt: 1,
	lastPlayedAt,
});

describe("continueListening", () => {
	it("未完了で実際に再生した項目だけを最終再生順に返す", () => {
		const result = continueListening([
			item("未再生"),
			item("古い", 10),
			item("完了", 30, true),
			item("新しい", 20),
		]);
		expect(result.map(({ id }) => id)).toEqual(["新しい", "古い"]);
	});

	it("利用不能項目を除外し上限を適用する", () => {
		const unavailable = { ...item("利用不能", 30), unavailable: true };
		expect(
			continueListening([unavailable, item("二", 20), item("一", 10)], 1).map(({ id }) => id),
		).toEqual(["二"]);
	});
});

describe("queueSections", () => {
	it("現在・明示した次・後続・再生履歴を別の意味として返す", () => {
		const current = item("現在", 40);
		const natural = item("通常の次", 10);
		const requested = item("指定した次", 20);
		const completed = item("再生済み", 30, true);
		const result = queueSections(
			[current, natural, requested, completed],
			current.id,
			requested.id,
		);
		expect(result.current?.id).toBe("現在");
		expect(result.next?.id).toBe("指定した次");
		expect(result.following.map(({ id }) => id)).toEqual(["通常の次"]);
		expect(result.history.map(({ id }) => id)).toEqual(["再生済み"]);
	});

	it("明示指定がなければ現在位置より後ろの未完了を次にする", () => {
		const result = queueSections([item("前"), item("現在"), item("次")], "現在", null);
		expect(result.next?.id).toBe("次");
		expect(result.following.map(({ id }) => id)).toEqual(["前"]);
	});

	it("読込不能項目を再生順と履歴から除外する", () => {
		const broken = { ...item("破損", 20, true), loadError: true };
		const result = queueSections([broken, item("再生可能")], null, null);
		expect(result.next?.id).toBe("再生可能");
		expect(result.history).toEqual([]);
	});
});
