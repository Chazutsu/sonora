import { describe, expect, it } from "vitest";
import { copyFor, resolveLocale } from "../src/i18n";

describe("Sonora localization", () => {
	it("follows Japanese system language", () => expect(resolveLocale("system", "ja-JP")).toBe("ja"));
	it("defaults other system languages to English", () =>
		expect(resolveLocale("system", "fr-FR")).toBe("en"));
	it("keeps both catalogs complete", () => {
		expect(Object.keys(copyFor("en", "en-US")).toSorted()).toEqual(
			Object.keys(copyFor("ja", "en-US")).toSorted(),
		);
	});
	it("provides English settings, commands, and operational notices", () => {
		const copy = copyFor("en", "ja-JP");

		expect(copy.settingsVoiceLanguage).toBe("Voice language");
		expect(copy.settingsReportIssue).toBe("Report an issue");
		expect(copy.settingsDonate).toBe("Donate");
		expect(copy.commandRetrySaving).toBe("Retry saving progress");
		expect(copy.noticeSaveFailed).toContain("iCloud");
		expect(copy.noticeSpeechUnavailable).toContain("unavailable");
	});
	it("provides Japanese settings, commands, and operational notices", () => {
		const copy = copyFor("ja", "en-US");

		expect(copy.settingsVoiceLanguage).toBe("読み上げ言語");
		expect(copy.settingsReportIssue).toBe("問題を報告");
		expect(copy.settingsDonate).toBe("寄付する");
		expect(copy.commandRetrySaving).toBe("進捗の保存を再試行");
		expect(copy.noticeSaveFailed).toContain("iCloud");
		expect(copy.noticeSpeechUnavailable).toContain("利用できない");
	});
	it("names the library filters and search scope literally in both languages", () => {
		const en = copyFor("en", "en-US");
		const ja = copyFor("ja", "ja-JP");

		expect(en.home).toBe("All");
		expect(ja.home).toBe("すべて");
		expect(en.searchLibrary).toBe("Search titles and chapter headings");
		expect(ja.searchLibrary).toBe("タイトルとチャプター見出しを検索");
	});
});
