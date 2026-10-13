import { describe, expect, it } from "vitest";
import { activeLyricIndex } from "../src/app";

describe("activeLyricIndex", () => {
	const lines = ["First. ", "Second."];

	it("tracks sentence boundaries", () => {
		expect(activeLyricIndex(lines, 0)).toBe(0);
		expect(activeLyricIndex(lines, lines[0]?.length ?? 0)).toBe(1);
	});

	it("keeps the final sentence selected after playback ends", () => {
		expect(activeLyricIndex(lines, 10_000)).toBe(1);
	});

	it("handles an empty transcript", () => {
		expect(activeLyricIndex([], 0)).toBe(-1);
	});
});
