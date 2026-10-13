import { describe, expect, it, vi } from "vitest";
import {
	RECORDING_INSTALL_STORAGE_KEY,
	RECORDING_ROOTS_STORAGE_KEY,
	migrateLegacyRecordingStorage,
	recordingInstallId,
	rememberRecordingRoot,
	type VaultLocalStorage,
} from "../src/recording-local-storage";

function appStorage(initial: Record<string, unknown> = {}) {
	const values = new Map(Object.entries(initial));
	const app: VaultLocalStorage = {
		loadLocalStorage: vi.fn((key: string) => values.get(key) ?? null),
		saveLocalStorage: vi.fn((key: string, value: unknown) => values.set(key, value)),
	};
	return { app, values };
}

describe("recording local storage", () => {
	it("migrates valid legacy values once without replacing vault-scoped values", () => {
		const { app, values } = appStorage({ [RECORDING_ROOTS_STORAGE_KEY]: ["Existing"] });
		const legacy = {
			getItem: vi.fn((key: string): string | null =>
				key.includes("roots") ? '["Legacy"]' : "legacy-install",
			),
		};

		migrateLegacyRecordingStorage(app, "Vault", legacy);
		expect(values.get(RECORDING_ROOTS_STORAGE_KEY)).toEqual(["Existing"]);
		expect(values.get(RECORDING_INSTALL_STORAGE_KEY)).toBe("legacy-install");

		legacy.getItem.mockReturnValue('["Changed"]');
		migrateLegacyRecordingStorage(app, "Vault", legacy);
		expect(legacy.getItem).toHaveBeenCalledTimes(1);
		expect(values.get(RECORDING_ROOTS_STORAGE_KEY)).toEqual(["Existing"]);
	});

	it("ignores malformed legacy values and completes migration safely", () => {
		const { app, values } = appStorage();
		migrateLegacyRecordingStorage(app, "Vault", {
			getItem: (key) => (key.includes("roots") ? "not-json" : ""),
		});
		expect(values.has(RECORDING_ROOTS_STORAGE_KEY)).toBe(false);
		expect(values.has(RECORDING_INSTALL_STORAGE_KEY)).toBe(false);
	});

	it("waits to migrate when legacy storage is temporarily unavailable", () => {
		const { app, values } = appStorage();
		migrateLegacyRecordingStorage(app, "Vault", null);
		migrateLegacyRecordingStorage(app, "Vault", {
			getItem: (key) => (key.includes("roots") ? '["Recovered"]' : "recovered-install"),
		});
		expect(values.get(RECORDING_ROOTS_STORAGE_KEY)).toEqual(["Recovered"]);
		expect(values.get(RECORDING_INSTALL_STORAGE_KEY)).toBe("recovered-install");
	});

	it("keeps the current recovery root first and caps history", () => {
		const history = Array.from({ length: 40 }, (_, index) => `Root ${index}`);
		const { app, values } = appStorage({ [RECORDING_ROOTS_STORAGE_KEY]: history });
		expect(rememberRecordingRoot(app, "Root 5")).toEqual([
			"Root 5",
			...history.filter((root) => root !== "Root 5").slice(0, 31),
		]);
		expect((values.get(RECORDING_ROOTS_STORAGE_KEY) as string[]).length).toBe(32);
	});

	it("reuses a vault-scoped install ID and creates one only when absent", () => {
		const { app } = appStorage({ [RECORDING_INSTALL_STORAGE_KEY]: "existing" });
		const createId = vi.fn(() => "created");
		expect(recordingInstallId(app, createId)).toBe("existing");
		expect(createId).not.toHaveBeenCalled();

		const empty = appStorage();
		expect(recordingInstallId(empty.app, createId)).toBe("created");
		expect(empty.values.get(RECORDING_INSTALL_STORAGE_KEY)).toBe("created");
	});
});
