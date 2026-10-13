import { describe, expect, it } from "vitest";
import { SONORA_DONATE_URL, SONORA_ISSUES_URL } from "../src/support";

describe("Sonora support links", () => {
	it("uses the public sponsor and issue destinations", () => {
		expect(SONORA_DONATE_URL).toBe("https://github.com/sponsors/ryo-ebata");
		expect(SONORA_ISSUES_URL).toBe("https://github.com/Chazutsu/sonora/issues");
	});
});
