import type { RecordingPayload } from "./recording-session";

const MANIFEST_VERSION = 2;

interface RecoveryPart {
	readonly index: number;
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
	readonly commitPath: string;
}

async function hashBytes(data: Readonly<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
interface RecoveryManifest<Context extends Readonly<Record<string, unknown>>> {
	readonly version: typeof MANIFEST_VERSION;
	readonly generation: number;
	readonly sessionId: string;
	readonly installId: string;
	readonly context: Context;
	readonly mimeType: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly state: "active" | "ready";
	readonly stoppedAt?: number;
	readonly durationMs?: number;
	readonly limit?: "duration" | "size" | null;
	readonly outputPath?: string;
	readonly parts: readonly RecoveryPart[];
	readonly nextChunkIndex: number;
}
interface ClaimRecord {
	readonly sessionId: string;
	readonly installId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly epoch: number;
}

export interface RecordingRecoveryAdapter {
	exists(path: string): Promise<boolean>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	read(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	stat?(path: string): Promise<{ size: number } | null>;
	write(path: string, data: string): Promise<void>;
	writeBinary(path: string, data: Readonly<ArrayBuffer>): Promise<void>;
	remove(path: string): Promise<void>;
	rename?(from: string, to: string): Promise<void>;
	rmdir?(path: string, recursive: boolean): Promise<void>;
}
export interface RecordingRecoveryStoreOptions {
	readonly adapter: Readonly<RecordingRecoveryAdapter>;
	readonly root: string;
	readonly installId: string;
	readonly ensureFolder: (path: string) => Promise<void>;
	readonly now?: () => number;
	readonly staleAfterMs?: number;
	readonly maxPendingSessions?: number;
	readonly maxPendingBytes?: number;
	readonly maxPendingAgeMs?: number;
	readonly claimSettleMs?: number;
	readonly claimLeaseMs?: number;
	readonly claimClockSkewMs?: number;
	readonly delay?: (milliseconds: number) => Promise<void>;
	readonly createId?: () => string;
}
export interface RecordingCheckpointStart<Context extends Readonly<Record<string, unknown>>> {
	readonly sessionId: string;
	readonly context: Context;
	readonly mimeType: string;
	readonly startedAt: number;
	readonly outputPath?: string;
}
export interface RecordingCheckpointPart {
	readonly sessionId: string;
	readonly index: number;
	readonly blob: Readonly<Blob>;
}

/** Immutable chunks plus a manifest commit pointer. Claims are advisory; deterministic output bytes are the primary duplicate defense. */
export class RecordingRecoveryStore<Context extends Readonly<Record<string, unknown>>> {
	private operation = Promise.resolve();
	private readonly now: () => number;
	private readonly staleAfterMs: number;
	private readonly maxPendingSessions: number;
	private readonly maxPendingBytes: number;
	private readonly claimEpochs = new Map<string, number>();
	constructor(private readonly options: Readonly<RecordingRecoveryStoreOptions>) {
		this.now = options.now ?? Date.now;
		this.staleAfterMs = options.staleAfterMs ?? 60_000;
		this.maxPendingSessions = options.maxPendingSessions ?? 20;
		this.maxPendingBytes = options.maxPendingBytes ?? 128 * 1024 * 1024;
	}
	begin(input: RecordingCheckpointStart<Context>): Promise<void> {
		return this.serial(async () => {
			await this.gcEmptyOrphans();
			await this.assertCapacity(0, true);
			await this.options.ensureFolder(this.sessionDirectory(input.sessionId));
			await this.writeManifest({
				version: MANIFEST_VERSION,
				generation: -1,
				sessionId: input.sessionId,
				installId: this.options.installId,
				context: input.context,
				mimeType: input.mimeType,
				startedAt: input.startedAt,
				outputPath: input.outputPath,
				heartbeatAt: this.now(),
				state: "active",
				parts: [],
				nextChunkIndex: 0,
			});
		});
	}
	append(input: Readonly<RecordingCheckpointPart>): Promise<void> {
		return this.serial(async () => {
			await this.assertCapacity(input.blob.size, false);
			const manifest = await this.adoptUncommittedParts(input.sessionId);
			if (manifest.state !== "active") throw new Error("Recording recovery session is finalized");
			if (input.index !== manifest.nextChunkIndex)
				throw new Error("Recording recovery part sequence is not contiguous");
			const id = (this.options.createId ?? (() => crypto.randomUUID()))();
			const path = this.partPath(input.sessionId, input.index, id);
			const commitPath = `${path}.commit.json`;
			if (await this.options.adapter.exists(path))
				throw new Error("Recording recovery immutable part already exists");
			const data = await input.blob.arrayBuffer();
			await this.options.adapter.writeBinary(path, data);
			const sha256 = await hashBytes(data);
			if (await this.options.adapter.exists(commitPath))
				throw new Error("Recording recovery immutable commit already exists");
			await this.options.adapter.write(
				commitPath,
				JSON.stringify({
					sessionId: input.sessionId,
					index: input.index,
					size: data.byteLength,
					sha256,
				}),
			);
			await this.writeManifest({
				...manifest,
				heartbeatAt: this.now(),
				nextChunkIndex: input.index + 1,
				parts: [
					...manifest.parts,
					{ index: input.index, path, size: data.byteLength, sha256, commitPath },
				],
			});
		});
	}
	markReady(payload: Readonly<RecordingPayload<Context>>): Promise<void> {
		return this.serial(async () => {
			const manifest = await this.adoptUncommittedParts(payload.recoveryId);
			await this.writeManifest({
				...manifest,
				heartbeatAt: this.now(),
				state: "ready",
				stoppedAt: payload.stoppedAt,
				durationMs: payload.durationMs,
				limit: payload.limit,
			});
		});
	}
	remove(sessionId: string): Promise<void> {
		return this.serial(async () => {
			const directory = this.sessionDirectory(sessionId);
			const inventory = await this.options.adapter.list(directory);
			for (const file of inventory.files) await this.options.adapter.remove(file);
			for (const folder of inventory.folders) {
				if (folder !== `${directory}/claims`)
					throw new Error(`Unknown recording recovery folder: ${folder}`);
				for (const file of (await this.options.adapter.list(folder)).files)
					await this.options.adapter.remove(file);
				await this.options.adapter.rmdir?.(folder, false);
			}
			await this.options.adapter.rmdir?.(directory, false);
			this.claimEpochs.delete(sessionId);
		});
	}
	async recover(): Promise<ReadonlyArray<Readonly<RecordingPayload<Context>>>> {
		if (!(await this.options.adapter.exists(this.options.root))) return [];
		const recovered: Array<Readonly<RecordingPayload<Context>>> = [];
		for (const folder of (await this.options.adapter.list(this.options.root)).folders.toSorted()) {
			if (folder === `${this.options.root}/.quarantine`) continue;
			const sessionId = folder.slice(folder.lastIndexOf("/") + 1);
			try {
				const manifest = await this.adoptUncommittedParts(sessionId);
				const recoverable =
					manifest.state === "ready" ||
					(manifest.installId === this.options.installId &&
						this.now() - manifest.heartbeatAt >= this.staleAfterMs);
				if (!recoverable || !(await this.claim(manifest))) continue;
				const chunks: Blob[] = [];
				for (let index = 0; index < manifest.parts.length; index += 1) {
					const part = manifest.parts[index];
					if (part?.index !== index || !this.isPartPath(sessionId, index, part.path))
						throw new Error("Recording recovery manifest has a part gap");
					const data = await this.options.adapter.readBinary(part.path);
					if (
						data.byteLength !== part.size ||
						(await hashBytes(data)) !== part.sha256 ||
						!(await this.validCommit(sessionId, part))
					)
						throw new Error("Recording recovery part is corrupt");
					chunks.push(new Blob([data], { type: manifest.mimeType }));
				}
				if (chunks.length === 0) continue;
				const stoppedAt = manifest.stoppedAt ?? manifest.heartbeatAt;
				const blob = new Blob(chunks, { type: manifest.mimeType });
				recovered.push(
					Object.freeze({
						context: Object.freeze({ ...manifest.context }) as Context,
						blob,
						mimeType: manifest.mimeType,
						size: blob.size,
						startedAt: manifest.startedAt,
						stoppedAt,
						durationMs: manifest.durationMs ?? Math.max(0, stoppedAt - manifest.startedAt),
						limit: manifest.limit ?? null,
						recoveryId: manifest.sessionId,
						outputPath: manifest.outputPath,
					}),
				);
			} catch {
				try {
					await this.quarantineSession(sessionId);
				} catch {
					// If quarantine storage is unavailable, retain the original session in place.
				}
				/* Quarantine is session-local; originals remain untouched. */
			}
		}
		return recovered;
	}
	async withClaim<T>(
		sessionId: string,
		operation: () => Promise<T>,
		cleanup?: () => Promise<void>,
	): Promise<T> {
		await this.assertOwnership(sessionId);
		const leaseMs = this.options.claimLeaseMs ?? 30_000;
		let renewalError: unknown = null;
		const timer = window.setInterval(
			() => {
				void this.renewClaim(sessionId).catch((error) => {
					renewalError = error;
				});
			},
			Math.max(1_000, leaseMs / 3),
		);
		try {
			const result = await operation();
			if (renewalError !== null) throw renewalError;
			await this.renewClaim(sessionId);
			await this.assertOwnership(sessionId);
			await cleanup?.();
			return result;
		} finally {
			window.clearInterval(timer);
		}
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operation.then(operation);
		this.operation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	private sessionDirectory(sessionId: string): string {
		if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error("Invalid recovery session id");
		return `${this.options.root}/${sessionId}`;
	}
	private partPath(sessionId: string, index: number, id: string): string {
		if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Invalid recording recovery part id");
		return `${this.sessionDirectory(sessionId)}/tail-${String(index).padStart(6, "0")}-${id}.part`;
	}
	private isPartPath(sessionId: string, index: number, path: string): boolean {
		const prefix = `${this.sessionDirectory(sessionId)}/tail-${String(index).padStart(6, "0")}-`;
		return path.startsWith(prefix) && /^[a-zA-Z0-9_-]+\.part$/u.test(path.slice(prefix.length));
	}
	private async readManifest(sessionId: string): Promise<RecoveryManifest<Context>> {
		const directory = this.sessionDirectory(sessionId);
		const valid: RecoveryManifest<Context>[] = [];
		for (const path of (await this.options.adapter.list(directory)).files) {
			const match = path.match(/\/manifest-(\d+)-[a-zA-Z0-9_-]+\.json$/u);
			if (!match) continue;
			try {
				const parsed = JSON.parse(await this.options.adapter.read(path)) as Partial<
					RecoveryManifest<Context>
				>;
				const filenameGeneration = Number(match[1]);
				if (
					parsed.version !== MANIFEST_VERSION ||
					parsed.sessionId !== sessionId ||
					parsed.generation !== filenameGeneration ||
					(parsed.state !== "active" && parsed.state !== "ready") ||
					!Array.isArray(parsed.parts) ||
					typeof parsed.nextChunkIndex !== "number" ||
					!parsed.context ||
					typeof parsed.mimeType !== "string" ||
					typeof parsed.startedAt !== "number" ||
					typeof parsed.heartbeatAt !== "number" ||
					typeof parsed.installId !== "string"
				)
					continue;
				valid.push(parsed as RecoveryManifest<Context>);
			} catch {
				// A torn latest generation must not hide an older valid generation.
			}
		}
		valid.sort((left, right) => right.generation - left.generation);
		if (!valid[0]) throw new Error("No valid recording recovery manifest generation");
		if (valid[1]?.generation === valid[0].generation)
			throw new Error("Ambiguous recording recovery manifest generation");
		return valid[0];
	}
	private async writeManifest(
		manifest: RecoveryManifest<Context>,
	): Promise<RecoveryManifest<Context>> {
		const next = { ...manifest, generation: manifest.generation + 1 };
		const id = (this.options.createId ?? (() => crypto.randomUUID()))();
		const path = `${this.sessionDirectory(manifest.sessionId)}/manifest-${next.generation}-${id}.json`;
		if (await this.options.adapter.exists(path))
			throw new Error("Recording recovery manifest generation already exists");
		await this.options.adapter.write(path, JSON.stringify(next));
		await this.options.adapter.write(
			`${this.sessionDirectory(manifest.sessionId)}/manifest-pointer.json`,
			JSON.stringify({ generation: next.generation, path }),
		);
		return next;
	}
	private async adoptUncommittedParts(sessionId: string): Promise<RecoveryManifest<Context>> {
		let manifest = await this.readManifest(sessionId);
		const referenced = new Set(manifest.parts.map((part) => part.path));
		const inventory = await this.options.adapter.list(this.sessionDirectory(sessionId));
		const candidates = inventory.files.filter(
			(path) => path.endsWith(".part") && !referenced.has(path),
		);
		let next = manifest.nextChunkIndex;
		while (true) {
			const prefix = `${this.sessionDirectory(sessionId)}/tail-${String(next).padStart(6, "0")}-`;
			const matches = candidates.filter((path) => path.startsWith(prefix));
			if (matches.length === 0) break;
			if (matches.length !== 1 || !this.isPartPath(sessionId, next, matches[0]!)) {
				await this.quarantineSession(sessionId);
				throw new Error("Ambiguous uncommitted recording part");
			}
			const path = matches[0]!;
			const data = await this.options.adapter.readBinary(path);
			const commitPath = `${path}.commit.json`;
			const sha256 = await hashBytes(data);
			const part = { index: next, path, size: data.byteLength, sha256, commitPath };
			if (data.byteLength === 0 || !(await this.validCommit(sessionId, part))) {
				await this.quarantineSession(sessionId);
				throw new Error("Uncommitted recording part has no valid commit sidecar");
			}
			manifest = {
				...manifest,
				parts: [...manifest.parts, part],
				nextChunkIndex: next + 1,
			};
			manifest = await this.writeManifest(manifest);
			next += 1;
		}
		const unadoptedPart = candidates.some(
			(path) => !manifest.parts.some((part) => part.path === path),
		);
		const orphanSidecar = inventory.files.some(
			(path) =>
				path.endsWith(".part.commit.json") &&
				!manifest.parts.some((part) => part.commitPath === path),
		);
		if (unadoptedPart || orphanSidecar) {
			await this.quarantineSession(sessionId);
			throw new Error("Recording recovery contains quarantined parts");
		}
		return manifest;
	}
	private async validCommit(sessionId: string, part: RecoveryPart): Promise<boolean> {
		try {
			const value = JSON.parse(await this.options.adapter.read(part.commitPath)) as Record<
				string,
				unknown
			>;
			return (
				value.sessionId === sessionId &&
				value.index === part.index &&
				value.size === part.size &&
				value.sha256 === part.sha256
			);
		} catch {
			return false;
		}
	}
	private async quarantineSession(sessionId: string): Promise<void> {
		if (!this.options.adapter.rename)
			throw new Error("Recording recovery quarantine is unavailable");
		const root = `${this.options.root}/.quarantine`;
		await this.options.ensureFolder(root);
		const target = `${root}/${sessionId}-${this.now()}-${(this.options.createId ?? (() => crypto.randomUUID()))()}`;
		await this.options.adapter.rename(this.sessionDirectory(sessionId), target);
	}
	private async claim(manifest: RecoveryManifest<Context>): Promise<boolean> {
		await this.options.ensureFolder(`${this.sessionDirectory(manifest.sessionId)}/claims`);
		const now = this.now();
		const record: ClaimRecord = {
			sessionId: manifest.sessionId,
			installId: this.options.installId,
			createdAt: now,
			expiresAt: now + (this.options.claimLeaseMs ?? 30_000),
			epoch: now,
		};
		await this.options.adapter.write(this.ownClaimPath(manifest.sessionId), JSON.stringify(record));
		await (
			this.options.delay ?? ((ms) => new Promise((resolve) => window.setTimeout(resolve, ms)))
		)(this.options.claimSettleMs ?? 750);
		const winner = await this.claimWinner(manifest.sessionId);
		const won = winner?.installId === this.options.installId && winner.epoch === record.epoch;
		if (won) this.claimEpochs.set(manifest.sessionId, record.epoch);
		if (!won && (await this.options.adapter.exists(this.ownClaimPath(manifest.sessionId))))
			await this.options.adapter.remove(this.ownClaimPath(manifest.sessionId));
		return won;
	}
	private async renewClaim(sessionId: string): Promise<void> {
		const path = this.ownClaimPath(sessionId);
		const record = JSON.parse(await this.options.adapter.read(path)) as ClaimRecord;
		if (record.epoch !== this.claimEpochs.get(sessionId))
			throw new Error("Recording recovery claim epoch changed");
		await this.options.adapter.write(
			path,
			JSON.stringify({ ...record, expiresAt: this.now() + (this.options.claimLeaseMs ?? 30_000) }),
		);
	}
	private async assertOwnership(sessionId: string): Promise<void> {
		const winner = await this.claimWinner(sessionId);
		if (
			winner?.installId !== this.options.installId ||
			winner.epoch !== this.claimEpochs.get(sessionId)
		)
			throw new Error("Recording recovery claim ownership was lost");
	}
	private ownClaimPath(sessionId: string): string {
		return `${this.sessionDirectory(sessionId)}/claims/${this.options.installId}.json`;
	}
	private async claimWinner(sessionId: string): Promise<ClaimRecord | null> {
		const directory = `${this.sessionDirectory(sessionId)}/claims`;
		const skew = this.options.claimClockSkewMs ?? 60_000;
		const claims: ClaimRecord[] = [];
		for (const path of (await this.options.adapter.list(directory)).files.filter((item) =>
			item.endsWith(".json"),
		)) {
			try {
				const value = JSON.parse(await this.options.adapter.read(path)) as ClaimRecord;
				if (
					value.sessionId !== sessionId ||
					!value.installId ||
					!Number.isFinite(value.createdAt) ||
					!Number.isFinite(value.expiresAt) ||
					!Number.isFinite(value.epoch)
				)
					throw new Error("invalid");
				if (value.expiresAt + skew <= this.now()) {
					await this.options.adapter.remove(path);
					continue;
				}
				claims.push(value);
			} catch {
				await this.options.adapter.remove(path);
			}
		}
		claims.sort(
			(a, b) =>
				a.createdAt - b.createdAt || a.installId.localeCompare(b.installId) || a.epoch - b.epoch,
		);
		return claims[0] ?? null;
	}
	private async assertCapacity(additionalBytes: number, addingSession: boolean): Promise<void> {
		if (!(await this.options.adapter.exists(this.options.root))) return;
		const { folders } = await this.options.adapter.list(this.options.root);
		const activeFolders = folders.filter((folder) => folder !== `${this.options.root}/.quarantine`);
		if (activeFolders.length + (addingSession ? 1 : 0) > this.maxPendingSessions)
			throw new Error("Recording recovery pending-session limit reached");
		const bytes = await this.binaryInventoryBytes(this.options.root);
		if (bytes + additionalBytes > this.maxPendingBytes)
			throw new Error("Recording recovery pending-byte limit reached");
	}
	private async binaryInventoryBytes(directory: string): Promise<number> {
		const inventory = await this.options.adapter.list(directory);
		let bytes = 0;
		for (const path of inventory.files)
			if (path.endsWith(".part")) {
				const stat = await this.options.adapter.stat?.(path);
				bytes += stat?.size ?? (await this.options.adapter.readBinary(path)).byteLength;
			}
		for (const folder of inventory.folders) bytes += await this.binaryInventoryBytes(folder);
		return bytes;
	}
	private async gcEmptyOrphans(): Promise<void> {
		if (!this.options.adapter.rmdir || !(await this.options.adapter.exists(this.options.root)))
			return;
		for (const folder of (await this.options.adapter.list(this.options.root)).folders) {
			const contents = await this.options.adapter.list(folder);
			if (contents.files.length === 0 && contents.folders.length === 0)
				await this.options.adapter.rmdir(folder, false);
		}
	}
}
