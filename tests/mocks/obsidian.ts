export class FuzzySuggestModal<T> {
	app: unknown;
	constructor(app: unknown) {
		this.app = app;
	}
	setPlaceholder() {}
	open() {}
	getItems(): T[] {
		return [];
	}
}

export class ItemView {
	readonly __mockItemView = true;
}
export class Plugin {
	readonly __mockPlugin = true;
}
export class PluginSettingTab {
	readonly __mockPluginSettingTab = true;
	update() {}
}
export class Setting {
	readonly __mockSetting = true;
}
export class TFile {
	readonly __mockFile = true;
}
export class Notice {
	readonly __mockNotice = true;
}

export function normalizePath(path: string): string {
	return path.replaceAll(/\/{2,}/gu, "/").replace(/^\//u, "");
}
