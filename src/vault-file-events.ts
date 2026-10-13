import type { VaultEventQueue } from "./vault-event-queue";

export interface VaultPathFile {
	readonly path: string;
}

export function enqueueVaultModify<File extends VaultPathFile>(
	queue: Readonly<VaultEventQueue>,
	eventFile: File,
	resolve: (path: string) => File | null,
	onModify: (file: File) => void | Promise<void>,
	shouldModify: (path: string) => boolean = () => true,
) {
	const { path } = eventFile;
	return queue.enqueueLatest(path, { type: "modify", path }, async () => {
		if (!shouldModify(path)) return;
		const current = resolve(path);
		if (current) await onModify(current);
	});
}

export function enqueueVaultRename<File extends VaultPathFile>(
	queue: Readonly<VaultEventQueue>,
	eventFile: File,
	oldPath: string,
	resolve: (path: string) => File | null,
	onRename: (path: string, oldPath: string, file: File | null) => void | Promise<void>,
) {
	const { path } = eventFile;
	return queue.enqueue({ type: "rename", path }, async () => {
		await onRename(path, oldPath, resolve(path));
	});
}
