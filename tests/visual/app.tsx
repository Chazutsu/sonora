import { createRoot } from "react-dom/client";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { createVirtualObsidian, initializeVirtualObsidian } from "virtual-obsidian";
import { SonoraApp } from "../../src/app";
import { chaptersFromMarkdown } from "../../src/content";
import { copyFor } from "../../src/i18n";
import { DEFAULT_SETTINGS, type QueueItem } from "../../src/types";

const queue: QueueItem[] = [
	{
		id: "note-1",
		path: "notes/product-strategy.md",
		title: "Product strategy notes for the next release",
		chapters: [
			{
				heading: "What matters next",
				level: 2,
				text: "Start with the listening loop. Keep the current sentence visible. Reduce friction on mobile.",
			},
			{ heading: "Open questions", level: 2, text: "How should recall sessions become podcasts?" },
		],
		chapterIndex: 0,
		completed: false,
		addedAt: 1,
		lastPlayedAt: 20,
		kind: "note",
	},
	{
		id: "drill-1",
		path: "language/spanish.md",
		title: "Spanish travel vocabulary",
		chapters: [{ heading: "la estación", level: 2, text: "the station" }],
		chapterIndex: 0,
		completed: false,
		addedAt: 2,
		lastPlayedAt: 10,
		kind: "drill",
	},
];

const noop = () => {};

const queuePreview: QueueItem[] = [
	...queue,
	{
		...queue[0]!,
		id: "note-2",
		path: "notes/research.md",
		title: "Research notes to review on the train",
		chapters: [{ heading: "Interview patterns", level: 2, text: "Review the findings." }],
		addedAt: 3,
	},
	{
		...queue[0]!,
		id: "note-3",
		path: "notes/decisions.md",
		title: "Architecture decisions",
		chapters: [{ heading: "Offline recovery", level: 2, text: "Keep recovery explicit." }],
		addedAt: 4,
	},
	{
		...queue[0]!,
		id: "done",
		path: "notes/finished.md",
		title: "Finished listening note",
		completed: true,
		lastPlayedAt: 30,
		addedAt: 5,
	},
];

const japaneseQueue: QueueItem[] = [
	{
		id: "note-1",
		path: "notes/product-strategy.md",
		title: "次のリリースで大切にしたいプロダクト戦略とモバイル再生体験の検討メモ",
		chapters: [
			{
				heading: "移動中でも迷わず操作できる情報設計",
				level: 2,
				text: "現在地と次の操作を明確にし、長い日本語でも重要な情報が隠れないようにする。",
			},
		],
		chapterIndex: 0,
		completed: false,
		addedAt: 1,
		lastPlayedAt: 20,
		kind: "note",
	},
	{
		id: "drill-1",
		path: "language/spanish.md",
		title: "旅行中に使うスペイン語の重要単語と会話表現を復習するための語学ドリル",
		chapters: [{ heading: "駅までの行き方を尋ねる", level: 2, text: "¿Dónde está la estación?" }],
		chapterIndex: 0,
		completed: false,
		addedAt: 2,
		lastPlayedAt: 10,
		kind: "drill",
	},
];

function Preview({ initialItems }: { initialItems: QueueItem[] }) {
	const params = new URLSearchParams(window.location.search);
	const scenario = params.get("scenario") ?? "mobile";
	const locale = scenario === "long-ja" ? "ja" : "en";
	const [items, setItems] = useState<QueueItem[]>(initialItems);
	const [activeItemId, setActiveItemId] = useState(initialItems[0]?.id ?? "");
	const [playerState, setPlayerState] = useState<"playing" | "paused">("playing");
	const [upNextItemId, setUpNextItemId] = useState<string | null>(initialItems[1]?.id ?? null);
	const active = items.find((item) => item.id === activeItemId);
	const updateActive = (update: (item: QueueItem) => QueueItem) =>
		setItems((current) => current.map((item) => (item.id === activeItemId ? update(item) : item)));

	return (
		<div className="visual-obsidian-view sonora-view">
			<SonoraApp
				queue={items}
				activeItemId={activeItemId}
				upNextItemId={upNextItemId}
				playerState={playerState}
				settings={DEFAULT_SETTINGS}
				recording={false}
				recordingRequesting={false}
				recordingAccessIssue={scenario === "recording-denied" ? "denied" : null}
				playbackError={null}
				spokenText={
					active?.kind === "drill"
						? (active.chapters[active.chapterIndex]?.heading ?? "")
						: "What matters next. Start with the listening loop. Keep the current sentence visible. Reduce friction on mobile. Preserve playback context. Keep controls reachable. Avoid duplicate actions. Respect the host toolbar. Test narrow screens. Finish with a stable layout."
				}
				spokenOffset={166}
				copy={copyFor(locale, locale === "ja" ? "ja-JP" : "en-US")}
				removalUndo={null}
				onBrowseNotes={noop}
				onBrowseVocabulary={noop}
				onCreateVocabularyTemplate={noop}
				onSelect={setActiveItemId}
				onSelectChapter={(id, chapterIndex) => {
					setActiveItemId(id);
					setItems((current) =>
						current.map((item) => (item.id === id ? { ...item, chapterIndex } : item)),
					);
				}}
				onPlayChapter={(id, chapterIndex) => {
					setActiveItemId(id);
					setItems((current) =>
						current.map((item) =>
							item.id === id ? { ...item, chapterIndex, lastPlayedAt: Date.now() } : item,
						),
					);
				}}
				onSetUpNext={setUpNextItemId}
				onReorder={async (sourceId, targetId, placement) => {
					setItems((current) => {
						const source = current.find((item) => item.id === sourceId);
						if (!source || sourceId === targetId) return current;
						const next = current.filter((item) => item.id !== sourceId);
						const targetIndex = next.findIndex((item) => item.id === targetId);
						if (targetIndex < 0) return current;
						next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, source);
						return next;
					});
					return true;
				}}
				onRemove={noop}
				onUndoRemove={noop}
				onDismissRemove={noop}
				onPlayPause={(id) => {
					if (id === activeItemId) {
						setPlayerState((current) => (current === "playing" ? "paused" : "playing"));
						return;
					}
					setActiveItemId(id);
					setPlayerState("playing");
				}}
				onPrevious={() =>
					updateActive((item) => ({ ...item, chapterIndex: Math.max(0, item.chapterIndex - 1) }))
				}
				onNext={() =>
					updateActive((item) => ({
						...item,
						chapterIndex: Math.min(item.chapters.length - 1, item.chapterIndex + 1),
					}))
				}
				onRestart={noop}
				onComplete={() => updateActive((item) => ({ ...item, completed: true }))}
				onToggleRecording={noop}
				onDismissRecordingIssue={noop}
				onRateChange={noop}
				onOpenSource={noop}
				onToggleLoop={noop}
			/>
			{scenario === "mobile" && (
				<button className="visual-obsidian-mobile-chrome" aria-label="Obsidian mobile menu">
					<MoreHorizontal size={22} />
				</button>
			)}
		</div>
	);
}

function scenarioQueue(): QueueItem[] {
	const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "mobile";
	return scenario === "empty"
		? []
		: scenario === "long-ja"
			? japaneseQueue
			: scenario === "queue"
				? queuePreview
				: queue;
}

function itemMarkdown(item: QueueItem): string {
	return item.chapters
		.map((chapter) => `${"#".repeat(chapter.level)} ${chapter.heading}\n\n${chapter.text}`)
		.join("\n\n");
}

async function main(): Promise<void> {
	await initializeVirtualObsidian();
	const sourceItems = scenarioQueue();
	const runtime = createVirtualObsidian({
		files: sourceItems.map((item) => ({ path: item.path, content: itemMarkdown(item) })),
		activeFile: sourceItems[0]?.path ?? null,
		mobile: window.innerWidth <= 720,
	});
	document.documentElement.dataset.virtualObsidianEngine = runtime.engine;
	const initialItems = await Promise.all(
		sourceItems.map(async (item) => {
			const file = runtime.app.vault.getAbstractFileByPath(item.path);
			if (!file || !("extension" in file)) throw new Error(`Missing virtual file: ${item.path}`);
			const markdown = await runtime.app.vault.read(file);
			return { ...item, chapters: chaptersFromMarkdown(markdown, item.title) };
		}),
	);
	createRoot(document.getElementById("root")!).render(<Preview initialItems={initialItems} />);
}

void main();
