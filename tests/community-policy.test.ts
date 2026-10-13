import { describe, expect, it } from "vitest";
import { SONORA_COMMAND_IDS } from "../src/commands";

describe("Obsidian Community Plugin policy", () => {
	it("does not repeat the plugin ID in the workspace command ID", () => {
		expect(SONORA_COMMAND_IDS.openWorkspace).toBe("open-workspace");
		expect(SONORA_COMMAND_IDS.openWorkspace).not.toBe("open-sonora");
		expect(SONORA_COMMAND_IDS.openWorkspace.startsWith("sonora-")).toBe(false);
	});
});
