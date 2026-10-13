export interface PersistenceJournalStorage {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(oldPath: string, newPath: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

type JournalEnvelope = {
	journalVersion: 3;
	operationId: string;
	sequence: number;
	snapshot: unknown;
};
type PreviousEnvelope = {
	journalVersion: 2;
	operationId: string;
	createdAt: number;
	snapshot: unknown;
};
type LegacyEnvelope = { journalVersion: 1; snapshot: unknown };

type JournalManifest = {
	manifestVersion: 1;
	manifestId: string;
	nextSequence: number;
	committedSequence: number;
	pending: Record<string, { path: string; sequence: number }>;
	committedOperationIds: string[];
};

export type JournalReceipt = {
	operationId: string;
	path: string;
	serialized: string;
	sequence: number;
	manifestId: string;
};
export type JournalRecovery<T> = { snapshot: T; receipts: JournalReceipt[] };
export type PersistenceWatermark = { manifestId: string; committedSequence: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isEnvelope = (value: unknown): value is JournalEnvelope =>
	isRecord(value) &&
	value.journalVersion === 3 &&
	typeof value.operationId === "string" &&
	typeof value.sequence === "number" &&
	Number.isSafeInteger(value.sequence) &&
	value.sequence >= 0 &&
	"snapshot" in value;

const isPreviousEnvelope = (value: unknown): value is PreviousEnvelope =>
	isRecord(value) &&
	value.journalVersion === 2 &&
	typeof value.operationId === "string" &&
	typeof value.createdAt === "number" &&
	Number.isFinite(value.createdAt) &&
	"snapshot" in value;

const isLegacyEnvelope = (value: unknown): value is LegacyEnvelope =>
	isRecord(value) && value.journalVersion === 1 && "snapshot" in value;

const isManifest = (value: unknown): value is JournalManifest => {
	if (!isRecord(value) || value.manifestVersion !== 1) return false;
	if (typeof value.manifestId !== "string" || !value.manifestId) return false;
	if (!Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 0) return false;
	if (!Number.isSafeInteger(value.committedSequence) || (value.committedSequence as number) < 0)
		return false;
	if (!isRecord(value.pending) || !Array.isArray(value.committedOperationIds)) return false;
	if (!value.committedOperationIds.every((id) => typeof id === "string")) return false;
	return Object.values(value.pending).every(
		(entry) =>
			isRecord(entry) &&
			typeof entry.path === "string" &&
			Number.isSafeInteger(entry.sequence) &&
			(entry.sequence as number) >= 0,
	);
};

const isPreviousManifest = (
	value: unknown,
): value is Omit<JournalManifest, "manifestId" | "committedSequence"> => {
	if (!isRecord(value) || value.manifestVersion !== 1) return false;
	if (!Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 0) return false;
	if (!isRecord(value.pending) || !Array.isArray(value.committedOperationIds)) return false;
	return value.committedOperationIds.every((id) => typeof id === "string");
};

const splitPath = (path: string) => {
	const separator = path.lastIndexOf("/");
	return separator < 0
		? { directory: "", filename: path }
		: { directory: path.slice(0, separator), filename: path.slice(separator + 1) };
};

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.toSorted()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
};

/** A manifest-indexed WAL. Any incomplete view fails closed instead of guessing. */
export class PersistenceJournal<T> {
	private readonly directory: string;
	private readonly filenameStem: string;
	private readonly filenameExtension: string;
	private readonly manifestPath: string;

	constructor(
		private readonly storage: PersistenceJournalStorage,
		private readonly legacyPath: string,
		private readonly validate: (value: unknown) => T,
		private readonly createOperationId: () => string = () => crypto.randomUUID(),
	) {
		const { directory, filename } = splitPath(legacyPath);
		const extensionIndex = filename.lastIndexOf(".");
		this.directory = directory;
		this.filenameStem = extensionIndex < 0 ? filename : filename.slice(0, extensionIndex);
		this.filenameExtension = extensionIndex < 0 ? "" : filename.slice(extensionIndex);
		this.manifestPath = `${directory ? `${directory}/` : ""}${this.filenameStem}.manifest${this.filenameExtension}`;
	}

	async load(
		watermark?: PersistenceWatermark,
		authoritativeSnapshot?: T,
	): Promise<JournalRecovery<T> | null> {
		const { manifest, envelopes } = await this.inspect(authoritativeSnapshot);
		if (watermark) {
			if (
				watermark.manifestId !== manifest.manifestId ||
				watermark.committedSequence < manifest.committedSequence
			) {
				throw new Error("Sonora persistence manifest does not match data.json");
			}
			if (watermark.committedSequence > manifest.committedSequence) {
				const prepared = Object.entries(manifest.pending).filter(
					([operationId, entry]) =>
						entry.sequence === watermark.committedSequence &&
						envelopes.get(operationId)?.envelope.sequence === entry.sequence,
				);
				if (prepared.length !== 1) {
					throw new Error("Sonora persistence manifest does not match data.json");
				}
			}
		}
		const pending = Object.entries(manifest.pending)
			.map(([operationId, entry]) => {
				const stored = envelopes.get(operationId);
				if (!stored || stored.envelope.sequence !== entry.sequence) {
					throw new Error("Sonora persistence journal is incomplete");
				}
				return {
					snapshot: this.validate(stored.envelope.snapshot),
					receipt: {
						operationId,
						path: entry.path,
						serialized: stored.serialized,
						sequence: entry.sequence,
						manifestId: manifest.manifestId,
					},
				};
			})
			.toSorted((left, right) => right.receipt.sequence - left.receipt.sequence);
		return pending[0]
			? { snapshot: pending[0].snapshot, receipts: pending.map((entry) => entry.receipt) }
			: null;
	}

	async write(snapshot: T): Promise<JournalReceipt> {
		const { manifest } = await this.inspect();
		const operationId = this.createOperationId();
		if (manifest.pending[operationId] || manifest.committedOperationIds.includes(operationId)) {
			throw new Error("Duplicate Sonora persistence operation ID");
		}
		const sequence = manifest.nextSequence;
		const safeId = operationId.replace(/[^a-zA-Z0-9_-]/g, "-");
		const path = `${this.directory ? `${this.directory}/` : ""}${this.filenameStem}.${safeId}${this.filenameExtension}`;
		const serialized = JSON.stringify({
			journalVersion: 3,
			operationId,
			sequence,
			snapshot,
		} satisfies JournalEnvelope);
		try {
			await this.storage.write(path, serialized);
		} catch (error) {
			// The path is unique to this operation, so best-effort cleanup cannot
			// damage an older intent. If cleanup also fails, inspect() fails closed.
			try {
				if (await this.storage.exists(path)) await this.storage.remove(path);
			} catch {
				// Preserve the original write error.
			}
			throw error;
		}
		await this.writeManifest({
			...manifest,
			nextSequence: sequence + 1,
			pending: { ...manifest.pending, [operationId]: { path, sequence } },
		});
		return { operationId, path, serialized, sequence, manifestId: manifest.manifestId };
	}

	async commit(receipts: readonly JournalReceipt[]): Promise<void> {
		if (!receipts.length) return;
		const { manifest, envelopes } = await this.inspect();
		const pending = { ...manifest.pending };
		const committed = new Set(manifest.committedOperationIds);
		for (const receipt of receipts) {
			const indexed = pending[receipt.operationId];
			const stored = envelopes.get(receipt.operationId);
			if (
				!indexed ||
				indexed.path !== receipt.path ||
				indexed.sequence !== receipt.sequence ||
				receipt.manifestId !== manifest.manifestId ||
				stored?.serialized !== receipt.serialized
			) {
				throw new Error("Sonora persistence receipt no longer matches the manifest");
			}
			delete pending[receipt.operationId];
			committed.add(receipt.operationId);
		}
		await this.writeManifest({
			...manifest,
			pending,
			committedSequence: Math.max(
				manifest.committedSequence,
				...receipts.map((receipt) => receipt.sequence),
			),
			committedOperationIds: [...committed],
		});
	}

	async clear(receipt: JournalReceipt): Promise<void> {
		if (!(await this.storage.exists(receipt.path))) return;
		if ((await this.storage.read(receipt.path)) !== receipt.serialized) return;
		await this.storage.remove(receipt.path);
	}

	watermark(receipt: JournalReceipt): PersistenceWatermark {
		return { manifestId: receipt.manifestId, committedSequence: receipt.sequence };
	}

	private async inspect(authoritativeSnapshot?: T): Promise<{
		manifest: JournalManifest;
		envelopes: Map<string, { envelope: JournalEnvelope; serialized: string }>;
	}> {
		let manifest = await this.readManifest();
		const listed = await this.storage.list(this.directory);
		const prefix = `${this.directory ? `${this.directory}/` : ""}${this.filenameStem}.`;
		const generationPaths = listed.files.filter(
			(path) =>
				path !== this.manifestPath &&
				path.startsWith(prefix) &&
				path.endsWith(this.filenameExtension),
		);
		const envelopes = new Map<string, { envelope: JournalEnvelope; serialized: string }>();
		const unindexed: Array<{
			path: string;
			envelope: JournalEnvelope;
			serialized: string;
		}> = [];
		for (const path of generationPaths) {
			const serialized = await this.storage.read(path);
			const parsed = this.parseEnvelope(path, serialized, manifest);
			if (envelopes.has(parsed.operationId))
				throw new Error("Duplicate Sonora persistence generation");
			envelopes.set(parsed.operationId, { envelope: parsed, serialized });
			const indexed = manifest.pending[parsed.operationId];
			const known = Boolean(indexed) || manifest.committedOperationIds.includes(parsed.operationId);
			if (!known) unindexed.push({ path, envelope: parsed, serialized });
			if (indexed && indexed.path !== path)
				throw new Error("Sonora persistence index path mismatch");
		}
		if (unindexed.length) {
			if (authoritativeSnapshot === undefined)
				throw new Error("Unindexed Sonora persistence generation");
			const adoptable = unindexed.filter(
				(candidate) => candidate.envelope.sequence === manifest.nextSequence,
			);
			const adopted = adoptable.length === 1 ? adoptable[0] : undefined;
			if (adopted) {
				// Validate before indexing an interrupted prepared write. The snapshot
				// remains the recovery source; data.json is not overwritten here.
				this.validate(adopted.envelope.snapshot);
				manifest = {
					...manifest,
					nextSequence: adopted.envelope.sequence + 1,
					pending: {
						...manifest.pending,
						[adopted.envelope.operationId]: {
							path: adopted.path,
							sequence: adopted.envelope.sequence,
						},
					},
				};
				await this.writeManifest(manifest);
			}
			for (const candidate of unindexed) {
				if (candidate === adopted) continue;
				// Preserve ambiguous/stale generations outside the journal namespace.
				// They can be inspected manually without blocking future writes.
				const orphanSnapshot = this.validate(candidate.envelope.snapshot);
				const disposition =
					canonicalJson(orphanSnapshot) === canonicalJson(authoritativeSnapshot)
						? "applied"
						: "ambiguous";
				const safeId = candidate.envelope.operationId.replace(/[^a-zA-Z0-9_-]/g, "-");
				const quarantineBase = `${candidate.path}.orphan-${disposition}-${safeId}`;
				const quarantinePath = (await this.storage.exists(quarantineBase))
					? `${quarantineBase}-${crypto.randomUUID()}`
					: quarantineBase;
				await this.storage.rename(candidate.path, quarantinePath);
				envelopes.delete(candidate.envelope.operationId);
			}
		}
		for (const operationId of Object.keys(manifest.pending)) {
			if (!envelopes.has(operationId)) throw new Error("Missing Sonora persistence generation");
		}
		return { manifest, envelopes };
	}

	private async readManifest(): Promise<JournalManifest> {
		if (!(await this.storage.exists(this.manifestPath))) {
			const recovered = await this.recoverManifestHead();
			if (recovered) return recovered;
			const migrated = await this.migrateManifest();
			await this.writeManifest(migrated);
			return migrated;
		}
		const parsed: unknown = JSON.parse(await this.storage.read(this.manifestPath));
		if (isManifest(parsed)) return parsed;
		if (isPreviousManifest(parsed)) {
			const upgraded: JournalManifest = {
				...parsed,
				manifestId: crypto.randomUUID(),
				committedSequence: 0,
			};
			await this.writeManifest(upgraded);
			return upgraded;
		}
		throw new Error("Invalid Sonora persistence manifest");
	}

	private async recoverManifestHead(): Promise<JournalManifest | null> {
		const listed = await this.storage.list(this.directory);
		const candidates = listed.files.filter(
			(path) =>
				path.startsWith(`${this.manifestPath}.next-`) ||
				path.startsWith(`${this.manifestPath}.backup-`),
		);
		const valid: Array<{ path: string; manifest: JournalManifest }> = [];
		for (const path of candidates) {
			try {
				const parsed: unknown = JSON.parse(await this.storage.read(path));
				if (isManifest(parsed)) valid.push({ path, manifest: parsed });
			} catch {
				// A partial artifact is never promoted. It remains available for inspection.
			}
		}
		const selected = valid.toSorted(
			(left, right) =>
				right.manifest.committedSequence - left.manifest.committedSequence ||
				right.manifest.nextSequence - left.manifest.nextSequence ||
				Number(right.path.includes(".next-")) - Number(left.path.includes(".next-")),
		)[0];
		if (!selected) return null;
		await this.storage.rename(selected.path, this.manifestPath);
		return selected.manifest;
	}

	private async migrateManifest(): Promise<JournalManifest> {
		const listed = await this.storage.list(this.directory);
		const prefix = `${this.directory ? `${this.directory}/` : ""}${this.filenameStem}.`;
		const paths = listed.files.filter(
			(path) =>
				path !== this.manifestPath &&
				path.startsWith(prefix) &&
				path.endsWith(this.filenameExtension),
		);
		if ((await this.storage.exists(this.legacyPath)) && !paths.includes(this.legacyPath)) {
			paths.push(this.legacyPath);
		}
		const candidates = paths.map((path) => {
			return { path, serialized: "" };
		});
		for (const candidate of candidates)
			candidate.serialized = await this.storage.read(candidate.path);
		const decoded = candidates.map((candidate) => {
			const parsed: unknown = JSON.parse(candidate.serialized);
			if (isEnvelope(parsed)) {
				return { path: candidate.path, operationId: parsed.operationId, order: parsed.sequence };
			}
			if (isPreviousEnvelope(parsed)) {
				return { path: candidate.path, operationId: parsed.operationId, order: parsed.createdAt };
			}
			if (isLegacyEnvelope(parsed) && candidate.path === this.legacyPath) {
				return { path: candidate.path, operationId: "legacy-v1", order: 0 };
			}
			throw new Error("Invalid Sonora persistence generation during migration");
		});
		decoded.sort(
			(left, right) =>
				left.order - right.order || left.operationId.localeCompare(right.operationId),
		);
		const pending: JournalManifest["pending"] = {};
		decoded.forEach((entry, index) => {
			pending[entry.operationId] = { path: entry.path, sequence: index + 1 };
		});
		return {
			manifestVersion: 1,
			manifestId: crypto.randomUUID(),
			nextSequence: decoded.length + 1,
			committedSequence: 0,
			pending,
			committedOperationIds: [],
		};
	}

	private parseEnvelope(
		path: string,
		serialized: string,
		manifest: JournalManifest,
	): JournalEnvelope {
		const parsed: unknown = JSON.parse(serialized);
		if (isEnvelope(parsed)) return parsed;
		if (isPreviousEnvelope(parsed)) {
			const sequence = manifest.pending[parsed.operationId]?.sequence;
			if (sequence === undefined) throw new Error("Unindexed previous Sonora generation");
			return {
				journalVersion: 3,
				operationId: parsed.operationId,
				sequence,
				snapshot: parsed.snapshot,
			};
		}
		if (isLegacyEnvelope(parsed) && path === this.legacyPath) {
			const sequence = manifest.pending["legacy-v1"]?.sequence;
			if (sequence === undefined) throw new Error("Unindexed legacy Sonora generation");
			return { journalVersion: 3, operationId: "legacy-v1", sequence, snapshot: parsed.snapshot };
		}
		throw new Error("Invalid Sonora persistence generation");
	}

	private async writeManifest(manifest: JournalManifest): Promise<void> {
		const replacementId = crypto.randomUUID();
		const temporaryPath = `${this.manifestPath}.next-${replacementId}`;
		const backupPath = `${this.manifestPath}.backup-${replacementId}`;
		await this.storage.write(temporaryPath, JSON.stringify(manifest));
		let previousMoved = false;
		try {
			if (await this.storage.exists(this.manifestPath)) {
				await this.storage.rename(this.manifestPath, backupPath);
				previousMoved = true;
			}
			await this.storage.rename(temporaryPath, this.manifestPath);
		} catch (error) {
			try {
				if (
					previousMoved &&
					!(await this.storage.exists(this.manifestPath)) &&
					(await this.storage.exists(backupPath))
				)
					await this.storage.rename(backupPath, this.manifestPath);
			} catch {
				// Startup recovery promotes the valid next/backup head.
			}
			throw error;
		}
		try {
			if (await this.storage.exists(backupPath)) await this.storage.remove(backupPath);
		} catch {
			// The new head is committed. A uniquely named backup is harmless and recoverable.
		}
	}
}
