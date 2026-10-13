import type { Chapter } from "./types";

export type VocabularyCard = {
	term: string;
	meaning: string;
	example?: string;
	pronunciation?: string;
};

const FIELD =
	/^\s*[-*+]\s*(meaning|意味|translation|example|例文|pronunciation|発音)\s*:\s*(.+)$/iu;

export function vocabularyFromMarkdown(markdown: string): VocabularyCard[] {
	const cards: VocabularyCard[] = [];
	let current: VocabularyCard | null = null;
	for (const line of markdown.split(/\r?\n/u)) {
		const heading = /^#{1,6}\s+(.+)$/u.exec(line);
		if (heading) {
			if (current?.meaning) cards.push(current);
			current = { term: heading[1]?.trim() ?? "", meaning: "" };
			continue;
		}
		const field = FIELD.exec(line);
		if (!field || !current) continue;
		const key = field[1]?.toLowerCase();
		const value = field[2]?.trim() ?? "";
		if (key === "meaning" || key === "意味" || key === "translation") current.meaning = value;
		if (key === "example" || key === "例文") current.example = value;
		if (key === "pronunciation" || key === "発音") current.pronunciation = value;
	}
	if (current?.meaning) cards.push(current);
	return cards.filter((card: Readonly<VocabularyCard>) => card.term && card.meaning);
}

export function vocabularyChapters(cards: readonly Readonly<VocabularyCard>[]): Chapter[] {
	return cards.map((card) => ({
		heading: card.term,
		level: 2,
		text: [card.pronunciation, card.meaning, card.example].filter(Boolean).join(". "),
	}));
}
