import { PluginSettingTab, normalizePath, type SettingDefinitionItem } from "obsidian";
import { copyFor } from "./i18n";
import { SONORA_DONATE_URL, SONORA_ISSUES_URL } from "./support";
import type SonoraPlugin from "./main";
import type { SonoraSettings } from "./types";

type SonoraSettingKey = keyof SonoraSettings;

export class SonoraSettingTab extends PluginSettingTab {
	constructor(
		app: SonoraPlugin["app"],
		private readonly plugin: SonoraPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<SonoraSettingKey>[] {
		const copy = copyFor(this.plugin.data.settings.interfaceLanguage);
		const voices = "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
		const voiceOptions = Object.fromEntries([
			["", copy.settingsVoiceAutomatic],
			...voices.map((voice) => [
				voice.name,
				`${voice.name} (${voice.lang})${voice.localService ? ` · ${copy.settingsVoiceDevice}` : ""}`,
			]),
		]);

		return [
			{
				name: copy.settingsInterfaceLanguage,
				control: {
					type: "dropdown",
					key: "interfaceLanguage",
					options: {
						system: copy.settingsSystem,
						en: copy.settingsEnglish,
						ja: copy.settingsJapanese,
					},
				},
			},
			{
				name: copy.settingsVoiceLanguage,
				desc: copy.settingsVoiceLanguageDesc,
				control: {
					type: "dropdown",
					key: "language",
					options: {
						system: copy.settingsSystem,
						"en-US": copy.settingsEnglish,
						"ja-JP": copy.settingsJapanese,
					},
				},
			},
			{
				name: copy.settingsVoice,
				desc: copy.settingsVoiceDesc,
				control: { type: "dropdown", key: "voiceName", options: voiceOptions },
			},
			{
				name: copy.settingsVoiceMemoFolder,
				control: { type: "text", key: "recordingFolder" },
			},
			{
				name: copy.settingsLinkVoiceMemos,
				control: { type: "toggle", key: "appendVoiceMemoLink" },
			},
			{
				name: copy.settingsRecallDelay,
				desc: copy.settingsRecallDelayDesc,
				control: {
					type: "slider",
					key: "recallDelaySeconds",
					min: 1,
					max: 10,
					step: 1,
				},
			},
			{
				name: copy.settingsSupport,
				desc: copy.settingsSupportDesc,
				render: (setting) => {
					setting
						.addButton((button) =>
							button
								.setButtonText(copy.settingsReportIssue)
								.onClick(() => window.open(SONORA_ISSUES_URL, "_blank", "noopener,noreferrer")),
						)
						.addButton((button) =>
							button
								.setButtonText(copy.settingsDonate)
								.onClick(() => window.open(SONORA_DONATE_URL, "_blank", "noopener,noreferrer")),
						);
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		return Reflect.get(this.plugin.data.settings, key);
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		switch (key) {
			case "interfaceLanguage":
				if (value !== "system" && value !== "en" && value !== "ja") return;
				await this.plugin.updateSettings({ interfaceLanguage: value });
				this.plugin.refreshView();
				this.update();
				return;
			case "language":
				if (value !== "system" && value !== "en-US" && value !== "ja-JP") return;
				await this.plugin.updateSettings({ language: value });
				return;
			case "voiceName":
				if (typeof value !== "string") return;
				await this.plugin.updateSettings({ voiceName: value });
				return;
			case "recordingFolder":
				if (typeof value !== "string") return;
				await this.plugin.updateSettings({ recordingFolder: normalizePath(value) });
				return;
			case "appendVoiceMemoLink":
				if (typeof value !== "boolean") return;
				await this.plugin.updateSettings({ appendVoiceMemoLink: value });
				return;
			case "recallDelaySeconds":
				if (typeof value !== "number") return;
				await this.plugin.updateSettings({ recallDelaySeconds: value });
		}
	}
}
