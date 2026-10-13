import type { Chapter } from "./types";

const FRONTMATTER = /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/u;
const FENCED_CODE = /```[\s\S]*?```/gu;
const GENERATED_REGION = /<!--\s*([\w-]+):start\s*-->[\s\S]*?<!--\s*\1:end\s*-->/gu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const OBSIDIAN_COMMENT = /%%[\s\S]*?%%/gu;
const EMBED = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/gu;
const WIKILINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/gu;

function normalizeCoverReference(value: string): string {
	return (
		value
			.replace(/^['"]|['"]$/gu, "")
			.replace(/^!?\[\[/u, "")
			.replace(/\]\]$/u, "")
			.split("|")[0]
			?.trim() ?? ""
	);
}

export function coverReferenceFromMarkdown(markdown: string): string | null {
	const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(markdown)?.[1] ?? "";
	const property = /^(?:cover|image|thumbnail):\s*(.+?)\s*$/imu.exec(frontmatter)?.[1]?.trim();
	if (property !== undefined) return normalizeCoverReference(property) || null;
	const markdownImage = /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/u.exec(markdown)?.[1];
	if (markdownImage !== undefined) return normalizeCoverReference(markdownImage) || null;
	const embed = /!\[\[([^\]|]+\.(?:avif|gif|jpe?g|png|svg|webp))(?:\|[^\]]+)?\]\]/iu.exec(
		markdown,
	)?.[1];
	return embed !== undefined ? normalizeCoverReference(embed) || null : null;
}

export function readableMarkdown(markdown: string): string {
	return markdown
		.replace(FRONTMATTER, "")
		.replace(FENCED_CODE, "")
		.replace(GENERATED_REGION, "")
		.replace(HTML_COMMENT, "")
		.replace(OBSIDIAN_COMMENT, "")
		.replace(EMBED, "$1")
		.replace(WIKILINK, (_match, target: string, alias?: string) =>
			alias !== undefined && alias !== "" ? alias : target,
		)
		.replace(MARKDOWN_LINK, "$1")
		.replace(/^\s{0,3}>\s?/gmu, "")
		.replace(/^\s*[-*+]\s+/gmu, "")
		.replace(/^\s*\d+[.)]\s+/gmu, "")
		.replace(/[*_~=`]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

export function chaptersFromMarkdown(markdown: string, fallbackTitle: string): Chapter[] {
	const source = markdown
		.replace(FRONTMATTER, "")
		.replace(FENCED_CODE, "")
		.replace(GENERATED_REGION, "")
		.replace(HTML_COMMENT, "")
		.replace(OBSIDIAN_COMMENT, "");
	const lines = source.split(/\r?\n/u);
	const chapters: Chapter[] = [];
	let heading = fallbackTitle;
	let level = 1;
	let body: string[] = [];

	const flush = () => {
		const text = readableMarkdown(body.join("\n"));
		if (text) chapters.push({ heading, level, text });
		body = [];
	};

	for (const line of lines) {
		const match = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (!match) {
			body.push(line);
			continue;
		}
		flush();
		heading = readableMarkdown(match[2] ?? fallbackTitle) || fallbackTitle;
		level = match[1]?.length ?? 1;
	}
	flush();

	return chapters.length
		? chapters
		: [{ heading: fallbackTitle, level: 1, text: readableMarkdown(source) }].filter(
				(chapter: Readonly<Chapter>) => chapter.text,
			);
}

export function splitForSpeech(text: string, maxLength = 260): string[] {
	if (!text) return [];
	const sentences = text.match(/[^。！？.!?]+[。！？.!?]+\s*|[^。！？.!?]+$/gu) ?? [];
	const chunks: string[] = [];
	for (const sentence of sentences) {
		if (sentence.length > maxLength) {
			for (let index = 0; index < sentence.length; index += maxLength)
				chunks.push(sentence.slice(index, index + maxLength));
		} else {
			chunks.push(sentence);
		}
	}
	return chunks;
}
