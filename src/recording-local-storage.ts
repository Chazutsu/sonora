export const RECORDING_ROOTS_STORAGE_KEY = "sonora-recording-roots";
export const RECORDING_INSTALL_STORAGE_KEY = "sonora-recording-install";
const RECORDING_STORAGE_MIGRATION_KEY = "sonora-recording-storage-migrated-v1";

export interface VaultLocalStorage {
	loadLocalStorage(key: string): unknown;
	saveLocalStorage(key: string, value: unknown): void;
}

export interface LegacyLocalStorage {
	getItem(key: string): string | null;
}

function rootsFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((root): root is string => typeof root === "string");
}

function legacyValue(storage: Readonly<LegacyLocalStorage> | null, key: string): unknown {
	if (!storage) return null;
	try {
		const value = storage.getItem(key);
		return value === null ? null : JSON.parse(value);
	} catch {
		return null;
	}
}

export function migrateLegacyRecordingStorage(
	app: Readonly<VaultLocalStorage>,
	vaultName: string,
	legacyStorage: Readonly<LegacyLocalStorage> | null,
): void {
	if (app.loadLocalStorage(RECORDING_STORAGE_MIGRATION_KEY) === true) return;
	if (!legacyStorage) return;

	if (app.loadLocalStorage(RECORDING_ROOTS_STORAGE_KEY) === null) {
		const roots = rootsFrom(legacyValue(legacyStorage, `sonora-recording-roots:${vaultName}`));
		if (roots.length > 0) app.saveLocalStorage(RECORDING_ROOTS_STORAGE_KEY, roots);
	}

	if (app.loadLocalStorage(RECORDING_INSTALL_STORAGE_KEY) === null) {
		let installId: string | null = null;
		try {
			installId = legacyStorage.getItem(`sonora-recording-install:${vaultName}`);
		} catch {
			// A missing legacy value must not prevent fresh vault-scoped storage.
		}
		if (typeof installId === "string" && installId.length > 0)
			app.saveLocalStorage(RECORDING_INSTALL_STORAGE_KEY, installId);
	}

	app.saveLocalStorage(RECORDING_STORAGE_MIGRATION_KEY, true);
}

export function rememberRecordingRoot(app: Readonly<VaultLocalStorage>, current: string): string[] {
	const roots = [
		current,
		...rootsFrom(app.loadLocalStorage(RECORDING_ROOTS_STORAGE_KEY)).filter(
			(root) => root !== current,
		),
	].slice(0, 32);
	app.saveLocalStorage(RECORDING_ROOTS_STORAGE_KEY, roots);
	return roots;
}

export function recordingInstallId(
	app: Readonly<VaultLocalStorage>,
	createId: () => string,
): string {
	const existing = app.loadLocalStorage(RECORDING_INSTALL_STORAGE_KEY);
	if (typeof existing === "string" && existing.length > 0) return existing;
	const created = createId();
	app.saveLocalStorage(RECORDING_INSTALL_STORAGE_KEY, created);
	return created;
}
