import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonComponent, Setting } from "obsidian";
import type SonoraPlugin from "../src/main";
import { SonoraSettingTab } from "../src/settings-tab";
import { DEFAULT_SETTINGS } from "../src/types";

function createTab() {
	const plugin = {
		data: { settings: { ...DEFAULT_SETTINGS } },
		updateSettings: vi.fn(async (patch: Partial<typeof DEFAULT_SETTINGS>) => {
			Object.assign(plugin.data.settings, patch);
		}),
		refreshView: vi.fn(async () => {}),
	};
	const tab = new SonoraSettingTab({} as SonoraPlugin["app"], plugin as unknown as SonoraPlugin);
	return { plugin, tab };
}

describe("SonoraSettingTab", () => {
	beforeEach(() => {
		Object.defineProperty(window, "speechSynthesis", {
			configurable: true,
			value: {
				getVoices: () => [{ name: "Local voice", lang: "en-US", localService: true }],
			},
		});
	});

	it("declares every setting so Obsidian can index it for settings search", () => {
		const { tab } = createTab();
		const definitions = tab.getSettingDefinitions();

		expect(definitions).toHaveLength(7);
		expect(
			definitions.map((definition) => ("name" in definition ? definition.name : null)),
		).toEqual([
			"Interface language",
			"Voice language",
			"Voice",
			"Voice memo folder",
			"Link voice memos to the source note",
			"Recall delay",
			"Support",
		]);
		expect(definitions[2]).toMatchObject({
			control: {
				type: "dropdown",
				key: "voiceName",
				options: { "Local voice": "Local voice (en-US) · device" },
			},
		});
	});

	it("persists normalized values through the existing settings path", async () => {
		const { plugin, tab } = createTab();

		await tab.setControlValue("recordingFolder", "/Voice//Memos");
		await tab.setControlValue("appendVoiceMemoLink", false);
		await tab.setControlValue("recallDelaySeconds", 8);

		expect(plugin.updateSettings.mock.calls).toEqual([
			[{ recordingFolder: "Voice/Memos" }],
			[{ appendVoiceMemoLink: false }],
			[{ recallDelaySeconds: 8 }],
		]);
	});

	it("keeps the issue and donation actions together in the support row", () => {
		const { tab } = createTab();
		const support = tab.getSettingDefinitions()[6];
		const actions: Array<{ label: string; click: () => void }> = [];
		const setting = {
			addButton(callback: (button: ButtonComponent) => unknown) {
				const action = { label: "", click: () => {} };
				const button = {
					setButtonText(label: string) {
						action.label = label;
						return button;
					},
					onClick(click: () => void) {
						action.click = click;
						return button;
					},
				};
				callback(button as ButtonComponent);
				actions.push(action);
				return setting;
			},
		};

		if (!support || !("render" in support) || !support.render)
			throw new Error("Missing support row");
		support.render(setting as Setting, {} as never);

		expect(actions.map(({ label }) => label)).toEqual(["Report an issue", "Donate"]);
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		actions[0]?.click();
		actions[1]?.click();
		expect(open.mock.calls).toEqual([
			["https://github.com/Chazutsu/sonora/issues", "_blank", "noopener,noreferrer"],
			["https://github.com/sponsors/ryo-ebata", "_blank", "noopener,noreferrer"],
		]);
	});

	it("rebuilds localized definitions after changing the interface language", async () => {
		const { plugin, tab } = createTab();
		const update = vi.spyOn(tab, "update");

		await tab.setControlValue("interfaceLanguage", "ja");

		expect(plugin.refreshView).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledOnce();
		const localized = tab.getSettingDefinitions()[0];
		expect(localized && "name" in localized ? localized.name : null).toBe("表示言語");
	});
});
