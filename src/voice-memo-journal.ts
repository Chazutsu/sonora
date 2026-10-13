import { MAX_PENDING_VOICE_MEMO_LINKS, sameVaultPath } from "./persistence";
import type { PendingVoiceMemoLink } from "./types";

export function voiceMemoLinkContent(audioPath: string): string {
	return `\n\n<!-- sonora-voice-response:start -->\n> [!note] Sonora voice response\n> ![[${audioPath}]]\n<!-- sonora-voice-response:end -->\n`;
}

export function hasVoiceMemoLink(markdown: string, audioPath: string): boolean {
	return markdown.includes(`![[${audioPath}]]`);
}

export function addPendingVoiceMemoLink<Item extends Readonly<PendingVoiceMemoLink>>(
	pending: readonly Item[],
	entry: Item,
): Item[] {
	const withoutDuplicate = pending.filter(
		(item) =>
			!sameVaultPath(item.audioPath, entry.audioPath) ||
			!sameVaultPath(item.sourcePath, entry.sourcePath),
	);
	return [...withoutDuplicate, entry].slice(-MAX_PENDING_VOICE_MEMO_LINKS);
}

export function removePendingVoiceMemoLink<Item extends Readonly<PendingVoiceMemoLink>>(
	pending: readonly Item[],
	audioPath: string,
	sourcePath: string,
): Item[] {
	return pending.filter(
		(item) =>
			!sameVaultPath(item.audioPath, audioPath) || !sameVaultPath(item.sourcePath, sourcePath),
	);
}

export function renamePendingVoiceMemoPaths(
	pending: readonly Readonly<PendingVoiceMemoLink>[],
	oldPath: string,
	path: string,
): PendingVoiceMemoLink[] {
	return pending.map((item) => ({
		...item,
		audioPath: sameVaultPath(item.audioPath, oldPath) ? path : item.audioPath,
		sourcePath: sameVaultPath(item.sourcePath, oldPath) ? path : item.sourcePath,
	}));
}
