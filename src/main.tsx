import {
	FuzzySuggestModal,
	ItemView,
	Notice,
	Plugin,
	TFile,
	normalizePath,
	type WorkspaceLeaf,
} from "obsidian";
import { createRoot, type Root } from "react-dom/client";
import { SonoraApp, activeItemAfterRemoval } from "./app";
import { SONORA_COMMAND_IDS } from "./commands";
import { chaptersFromMarkdown, coverReferenceFromMarkdown } from "./content";
import { copyFor, recordingSaveMessages } from "./i18n";
import {
	deserializeData,
	deserializePersistenceWatermark,
	sameVaultPath,
	serializeData,
} from "./persistence";
import { PersistenceQueue } from "./persistence-queue";
import { PersistenceJournal } from "./persistence-journal";
import { FileRefreshCoordinator } from "./file-refresh-coordinator";
import { visibleSpeechSegment } from "./progress-throttle";
import { RecordingSession, type RecordingPayload } from "./recording-session";
import { classifyRecordingAccessError, type RecordingAccessIssue } from "./recording-access";
import { recordingOutputPath, saveRecordingPayload } from "./recording-save";
import {
	addPendingVoiceMemoLink,
	hasVoiceMemoLink,
	removePendingVoiceMemoLink,
	renamePendingVoiceMemoPaths,
	voiceMemoLinkContent,
} from "./voice-memo-journal";
import { SpeechPlayer, type PlayerState } from "./player";
import { advanceListeningAfterEnd, setUpNextDurably } from "./playback-transition";
import { reorderQueueById, reorderQueueDurably, type QueuePlacement } from "./queue-reorder";
import {
	DEFAULT_SETTINGS,
	type QueueItem,
	type ReadonlyQueueItem,
	type SonoraData,
	type SonoraSettings,
	type StoredSonoraData,
} from "./types";
import { SonoraSettingTab } from "./settings-tab";
import { vocabularyChapters, vocabularyFromMarkdown } from "./vocabulary";
import { VaultEventQueue } from "./vault-event-queue";
import { enqueueVaultModify, enqueueVaultRename } from "./vault-file-events";
import { hydrateQueueItems } from "./queue-hydration";
import { resolveRecordingTarget } from "./recording-target";
import { RecordingRecoveryStore, type RecordingCheckpointPart } from "./recording-recovery-store";
import {
	migrateLegacyRecordingStorage,
	recordingInstallId,
	rememberRecordingRoot,
} from "./recording-local-storage";
import { ViewRegistry, type RenderableView } from "./view-registry";
import {
	DEFAULT_REMOVAL_UNDO_DURATION_MS,
	RemovalUndoHistory,
	restoreRemovedItem,
	shouldRestoreRemovedAsActive,
} from "./removal-undo";

const VIEW_TYPE = "sonora-listening-workspace";

function legacyBrowserStorage(): { getItem(key: string): string | null } | null {
	try {
		const storage = Reflect.get(window, ["local", "Storage"].join("")) as unknown;
		if (
			typeof storage === "object" &&
			storage !== null &&
			typeof Reflect.get(storage, "getItem") === "function"
		)
			return storage as { getItem(key: string): string | null };
	} catch {
		// Storage access may be unavailable in hardened or private web views.
	}
	return null;
}

type RecordingContext = Record<string, unknown> & {
	itemId: string;
	path: string;
	title: string;
};

class NotePickerModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: Readonly<SonoraPlugin["app"]>,
		private readonly mode: "note" | "drill",
		private readonly onChoose: (file: Readonly<TFile>) => void,
	) {
		super(app);
		this.setPlaceholder(
			mode === "drill" ? "Choose a vocabulary note…" : "Choose a note to listen to…",
		);
	}
	getItems() {
		return this.app.vault
			.getMarkdownFiles()
			.toSorted(
				(
					left: { readonly stat: { readonly mtime: number } },
					right: { readonly stat: { readonly mtime: number } },
				) => right.stat.mtime - left.stat.mtime,
			);
	}
	getItemText(file: Readonly<TFile>) {
		const folder = file.parent?.path;
		return folder !== undefined && folder !== "" && folder !== "/"
			? `${file.basename} — ${folder}`
			: file.basename;
	}
	onChooseItem(file: Readonly<TFile>) {
		this.onChoose(file);
	}
}

class SonoraView extends ItemView {
	private root: Root | null = null;
	constructor(
		leaf: Readonly<WorkspaceLeaf>,
		private readonly plugin: Readonly<SonoraPlugin>,
	) {
		super(leaf);
	}
	getViewType() {
		return VIEW_TYPE;
	}
	getDisplayText() {
		return "Sonora";
	}
	getIcon() {
		return "headphones";
	}
	async onOpen() {
		this.contentEl.empty();
		this.contentEl.addClass("sonora-view");
		this.root = createRoot(this.contentEl);
		this.plugin.registerOpenView(this);
		this.render();
		await Promise.resolve();
	}
	async onClose() {
		this.plugin.unregisterOpenView(this);
		this.root?.unmount();
		this.root = null;
		await Promise.resolve();
	}
	render() {
		this.root?.render(
			<SonoraApp
				queue={this.plugin.data.queue}
				activeItemId={this.plugin.data.activeItemId}
				upNextItemId={this.plugin.data.upNextItemId}
				playerState={this.plugin.playerState}
				settings={this.plugin.data.settings}
				recording={this.plugin.recording}
				recordingRequesting={this.plugin.recordingRequesting}
				recordingAccessIssue={this.plugin.recordingAccessIssue}
				playbackError={this.plugin.playbackError}
				spokenText={this.plugin.spokenText}
				spokenOffset={this.plugin.spokenOffset}
				copy={copyFor(this.plugin.data.settings.interfaceLanguage)}
				removalUndo={this.plugin.latestRemovalUndo(this)}
				onBrowseNotes={() => {
					this.plugin.openNotePicker("note");
				}}
				onBrowseVocabulary={() => {
					this.plugin.openNotePicker("drill");
				}}
				onCreateVocabularyTemplate={() => void this.plugin.createVocabularyTemplate()}
				onSelect={(id) => void this.plugin.select(id)}
				onSelectChapter={(id, chapterIndex) => void this.plugin.selectChapter(id, chapterIndex)}
				onPlayChapter={(id, chapterIndex) => void this.plugin.playChapter(id, chapterIndex)}
				onSetUpNext={(id) => void this.plugin.setUpNext(id)}
				onReorder={async (sourceId, targetId, placement) => {
					const result = this.plugin.reorderQueue(sourceId, targetId, placement);
					await Promise.resolve();
					return result;
				}}
				onRemove={(id, focusUndo, nextVisibleItemId) =>
					void this.plugin.remove(id, focusUndo ? this : null, nextVisibleItemId)
				}
				onUndoRemove={async (id) => {
					const result = this.plugin.undoRemove(id);
					await Promise.resolve();
					return result;
				}}
				onDismissRemove={(id) => void this.plugin.dismissRemove(id)}
				onPlayPause={(id) => {
					void this.plugin.playPause(id);
				}}
				onPrevious={(id) => void this.plugin.previous(id)}
				onNext={(id) => void this.plugin.next(id)}
				onRestart={(id) => {
					this.plugin.restart(id);
				}}
				onComplete={(id) => void this.plugin.complete(id)}
				onToggleRecording={(id) => void this.plugin.toggleRecording(id)}
				onDismissRecordingIssue={() => {
					this.plugin.dismissRecordingIssue();
				}}
				onRateChange={(rate) => void this.plugin.setRate(rate)}
				onOpenSource={(id) => void this.plugin.openSource(id)}
				onToggleLoop={(id) => void this.plugin.toggleLoop(id)}
			/>,
		);
	}
}

export default class SonoraPlugin extends Plugin {
	data: SonoraData = {
		settings: DEFAULT_SETTINGS,
		queue: [],
		activeItemId: null,
		upNextItemId: null,
		pendingVoiceMemoLinks: [],
	};
	playerState: PlayerState = "idle";
	recording = false;
	recordingRequesting = false;
	recordingAccessIssue: RecordingAccessIssue | null = null;
	playbackError: string | null = null;
	spokenText = "";
	spokenOffset = 0;
	private readonly views = new ViewRegistry<Readonly<RenderableView>>();
	private player: SpeechPlayer | null = null;
	private recordingSession: RecordingSession<RecordingContext> | null = null;
	private recordingRecovery: RecordingRecoveryStore<RecordingContext> | null = null;
	private readonly recordingRecoveries = new Map<
		string,
		RecordingRecoveryStore<RecordingContext>
	>();
	private recordingRecoveryInstallId = "";
	private lastMarkdownFile: TFile | null = null;
	private playbackStage: "chapter" | "drill-prompt" | "drill-answer" = "chapter";
	private recallTimer: number | null = null;
	private transportGeneration = 0;
	private renderedProgressKey: string | null = null;
	private persistenceQueue: PersistenceQueue<StoredSonoraData> | null = null;
	private persistenceJournal: PersistenceJournal<StoredSonoraData> | null = null;
	private refreshCoordinator: FileRefreshCoordinator<string> | null = null;
	private vaultEvents: VaultEventQueue | null = null;
	private readonly removalUndo = new RemovalUndoHistory(DEFAULT_REMOVAL_UNDO_DURATION_MS);
	private removalUndoTimer: number | null = null;
	private removalUndoFocusView: Readonly<RenderableView> | null = null;

	async onload() {
		try {
			migrateLegacyRecordingStorage(this.app, this.app.vault.getName(), legacyBrowserStorage());
		} catch {
			// Recovery storage remains usable for this session even if the host
			// rejects persistent browser storage.
		}
		const journalPath = normalizePath(
			`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/pending-save.json`,
		);
		this.persistenceJournal = new PersistenceJournal(this.app.vault.adapter, journalPath, (value) =>
			serializeData(deserializeData(value)),
		);
		const storedData = await this.loadData();
		let journalReady = true;
		let pendingRecovery = null;
		let lastSaveFailureNoticeAt = Number.NEGATIVE_INFINITY;
		const notifySaveFailure = () => {
			const now = Date.now();
			if (now - lastSaveFailureNoticeAt < 1_000) return;
			lastSaveFailureNoticeAt = now;
			new Notice(copyFor(this.data.settings.interfaceLanguage).noticeSaveFailed);
		};
		try {
			pendingRecovery = await this.persistenceJournal.load(
				deserializePersistenceWatermark(storedData),
				serializeData(deserializeData(storedData)),
			);
		} catch {
			journalReady = false;
		}
		this.data = deserializeData(pendingRecovery?.snapshot ?? storedData);
		const copy = copyFor(this.data.settings.interfaceLanguage);
		if (!journalReady) notifySaveFailure();
		this.persistenceQueue = new PersistenceQueue(
			async (snapshot: Readonly<StoredSonoraData>) => {
				if (!journalReady) throw new Error("Sonora persistence journal is unavailable");
				const receipt = await this.persistenceJournal?.write(snapshot);
				if (receipt) {
					await this.saveData({
						...snapshot,
						persistenceWatermark: this.persistenceJournal?.watermark(receipt),
					});
					await this.persistenceJournal?.commit([receipt]);
					await this.persistenceJournal?.clear(receipt);
				} else {
					throw new Error("Sonora persistence journal is unavailable");
				}
			},
			{
				onError: notifySaveFailure,
			},
		);
		if (pendingRecovery) {
			await this.persistenceQueue.save(pendingRecovery.snapshot);
			if (!this.persistenceQueue.dirty) {
				try {
					await this.persistenceJournal.commit(pendingRecovery.receipts);
					for (const receipt of pendingRecovery.receipts)
						await this.persistenceJournal.clear(receipt);
				} catch {
					journalReady = false;
					notifySaveFailure();
				}
			}
		}
		this.refreshCoordinator = new FileRefreshCoordinator(
			async (path) => {
				const file = this.resolveQueueFile(path);
				if (!file) throw new Error(`Missing Vault file: ${path}`);
				const markdown = this.app.vault.cachedRead(file);
				await Promise.resolve();
				return markdown;
			},
			(markdown) => markdown,
		);
		this.vaultEvents = new VaultEventQueue({
			onError: () => {
				new Notice(this.copy().noticeVaultUpdateFailed);
			},
			onPressure: () => {
				new Notice(this.copy().noticeVaultPressure);
			},
		});
		const recoveryRoot = normalizePath(`${this.data.settings.recordingFolder}/.sonora-pending`);
		this.recordingRecoveryInstallId = this.recordingInstallId();
		for (const root of this.rememberRecordingRoot(recoveryRoot))
			this.recordingRecoveries.set(root, this.createRecordingRecovery(root));
		this.recordingRecovery = this.recordingRecoveries.get(recoveryRoot) ?? null;
		this.recordingSession = new RecordingSession<RecordingContext>({
			requestStream: async () => {
				const stream = navigator.mediaDevices.getUserMedia({ audio: true });
				await Promise.resolve();
				return stream;
			},
			createRecorder: (stream) => new MediaRecorder(stream as MediaStream),
			resolveOutputPath: ({ context, mimeType, startedAt }) =>
				recordingOutputPath(
					this.data.settings.recordingFolder,
					context.title,
					mimeType,
					startedAt,
					normalizePath,
				),
			onSave: async (payload) => {
				await this.enqueueRecordingSave(payload);
			},
			onCheckpointStart: async (input) => {
				if (!this.recordingRecovery) throw new Error("Recording recovery is unavailable");
				const checkpoint = this.recordingRecovery.begin(input);
				await Promise.resolve();
				return checkpoint;
			},
			onCheckpointPart: async (input: Readonly<RecordingCheckpointPart>) => {
				if (!this.recordingRecovery) throw new Error("Recording recovery is unavailable");
				const checkpoint = this.recordingRecovery.append(input);
				await Promise.resolve();
				return checkpoint;
			},
			onCheckpointReady: async (payload) => {
				if (!this.recordingRecovery) throw new Error("Recording recovery is unavailable");
				const checkpoint = this.recordingRecovery.markReady(payload);
				await Promise.resolve();
				return checkpoint;
			},
			onSaveConfirmed: async (sessionId) => {
				if (!this.recordingRecovery) throw new Error("Recording recovery is unavailable");
				const removal = this.recordingRecovery.remove(sessionId);
				await Promise.resolve();
				return removal;
			},
			onPhaseChange: (phase) => {
				this.recording = phase === "recording" || phase === "stopping" || phase === "saving";
				this.recordingRequesting = phase === "requesting";
				if (phase === "recording") this.recordingAccessIssue = null;
				if (phase === "idle") this.syncRecordingRecoveryRoot();
				this.refresh();
			},
			onError: (error, stage) => {
				const classified = classifyRecordingAccessError(error);
				this.recordingAccessIssue =
					stage === "access" || classified === "unsupported" ? classified : "transient";
				this.refresh();
			},
		});
		this.lastMarkdownFile = this.resolveInitialSourceFile();
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file?.extension === "md") this.lastMarkdownFile = file;
				this.refresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") this.enqueueFileModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.enqueueFileRename(file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					const { path } = file;
					this.vaultEvents?.enqueue({ type: "delete", path }, async () => {
						await this.markFileUnavailable(path);
					});
				}
			}),
		);
		if ("speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined") {
			this.player = new SpeechPlayer(
				window.speechSynthesis,
				() => new SpeechSynthesisUtterance(),
				(state) => {
					this.playerState = state;
					this.updateMediaSessionState(
						state === "playing" ? "playing" : state === "paused" ? "paused" : "none",
					);
					this.refresh();
				},
				() => void this.advanceAfterEnd(this.transportGeneration),
				(character) => {
					this.spokenOffset = character;
					const progressKey = `${this.transportGeneration}:${visibleSpeechSegment(this.spokenText, character)}`;
					if (progressKey === this.renderedProgressKey) return;
					this.renderedProgressKey = progressKey;
					this.refresh();
				},
				() => {
					this.playbackError = "Speech stopped unexpectedly. Try another system voice.";
					this.refresh();
				},
			);
		}
		this.registerView(VIEW_TYPE, (leaf) => {
			return new SonoraView(leaf, this);
		});
		this.addRibbonIcon("headphones", copy.openSonora, () => void this.activateView());
		this.addCommand({
			id: SONORA_COMMAND_IDS.openWorkspace,
			name: copy.commandOpenWorkspace,
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "retry-saving-progress",
			name: copy.commandRetrySaving,
			callback: () => void this.persistenceQueue?.retry(),
		});
		this.addCommand({
			id: "add-active-note",
			name: copy.commandAddActiveNote,
			callback: () => void this.addActiveNote(),
		});
		this.addCommand({
			id: "add-vocabulary-drill",
			name: copy.commandAddVocabulary,
			callback: () => void this.addVocabularyDrill(),
		});
		this.addCommand({
			id: "play-pause",
			name: copy.commandPlayPause,
			callback: async () => {
				await this.playPause();
			},
		});
		this.addCommand({
			id: "record-response",
			name: copy.commandRecordResponse,
			callback: () => void this.toggleRecording(),
		});
		this.addCommand({
			id: "retry-voice-memo-links",
			name: copy.commandRetryVoiceMemoLinks,
			callback: () => {
				void this.retryPendingVoiceMemoLinks(true);
			},
		});
		this.addCommand({
			id: "retry-loading-queue",
			name: copy.commandRetryLoadingQueue,
			callback: () => {
				this.enqueueQueueHydration();
			},
		});
		this.addSettingTab(new SonoraSettingTab(this.app, this));
		this.configureMediaSession();
		this.app.workspace.onLayoutReady(() => {
			this.vaultEvents?.enqueue({ type: "initialize", path: "/" }, async () => {
				await this.initializeQueue();
				await this.retryPendingVoiceMemoLinks(false);
				await this.recoverRecordings();
			});
		});
	}

	onunload() {
		this.clearRemovalUndoTimer();
		this.removalUndo.clear();
		this.persistenceQueue?.dispose();
		void this.vaultEvents?.close({ discardPending: true });
		this.cancelRecallTimer();
		this.player?.stop();
		this.recordingSession?.unload();
		this.clearMediaSession();
	}

	async activateView() {
		let [leaf] = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (!leaf) {
			leaf = this.app.workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	registerOpenView(view: Readonly<RenderableView>): void {
		this.views.add(view);
	}

	unregisterOpenView(view: Readonly<RenderableView>): void {
		this.views.delete(view);
	}

	async addActiveNote() {
		const file = this.sourceFile();
		if (!file) {
			new Notice(this.copy().noticeOpenMarkdown);
			return;
		}
		await this.addFile(file, "note");
	}

	openNotePicker(mode: "note" | "drill") {
		new NotePickerModal(this.app, mode, (file) => void this.addFile(file, mode)).open();
	}

	private async addFile(file: Readonly<TFile>, mode: "note" | "drill") {
		if (mode === "drill") {
			await this.addVocabularyFile(file);
			return;
		}
		const markdown = await this.app.vault.cachedRead(file);
		const chapters = chaptersFromMarkdown(markdown, file.basename);
		const coverUrl = this.coverUrl(file, markdown);
		if (!chapters.length) {
			new Notice(this.copy().noticeNoReadableText);
			return;
		}
		this.transportGeneration += 1;
		this.resetPlaybackPresentation();
		const existing = this.data.queue.find(
			(item: ReadonlyQueueItem) => sameVaultPath(item.path, file.path) && item.kind !== "drill",
		);
		if (existing) {
			this.data.activeItemId = existing.id;
			existing.title = file.basename;
			existing.chapters = chapters;
			existing.coverUrl = coverUrl;
			existing.chapterIndex = Math.min(
				existing.chapterIndex,
				Math.max(0, existing.chapters.length - 1),
			);
		} else {
			const item: QueueItem = {
				id: crypto.randomUUID(),
				path: file.path,
				title: file.basename,
				chapters,
				chapterIndex: 0,
				completed: false,
				addedAt: Date.now(),
				kind: "note",
				coverUrl,
			};
			this.data.queue.push(item);
			this.data.activeItemId = item.id;
		}
		await this.persist();
		await this.activateView();
		this.refresh();
	}

	async addVocabularyDrill() {
		const file = this.sourceFile();
		if (!file) {
			new Notice(this.copy().noticeOpenVocabulary);
			return;
		}
		await this.addVocabularyFile(file);
	}

	private async addVocabularyFile(file: Readonly<TFile>) {
		const markdown = await this.app.vault.cachedRead(file);
		const chapters = vocabularyChapters(vocabularyFromMarkdown(markdown));
		if (!chapters.length) {
			new Notice(this.copy().noticeNoVocabularyCards);
			return;
		}
		this.transportGeneration += 1;
		this.resetPlaybackPresentation();
		const existing = this.data.queue.find(
			(item: ReadonlyQueueItem) => sameVaultPath(item.path, file.path) && item.kind === "drill",
		);
		if (existing) {
			existing.chapters = chapters;
			existing.chapterIndex = Math.min(existing.chapterIndex, chapters.length - 1);
			existing.completed = false;
			this.data.activeItemId = existing.id;
		} else {
			const item: QueueItem = {
				id: crypto.randomUUID(),
				path: file.path,
				title: file.basename,
				chapters,
				chapterIndex: 0,
				completed: false,
				addedAt: Date.now(),
				kind: "drill",
				loop: true,
			};
			this.data.queue.push(item);
			this.data.activeItemId = item.id;
		}
		await this.persist();
		await this.activateView();
		this.refresh();
	}

	async createVocabularyTemplate() {
		const folder = "Sonora";
		await this.ensureFolder(folder);
		const path = `${folder}/Vocabulary starter.md`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		const file =
			existing instanceof TFile
				? existing
				: await this.app.vault.create(
						path,
						`---\nsonora: vocabulary\nlanguage: en-US\n---\n\n# Vocabulary starter\n\n## resilient\n\n- meaning: 回復力がある\n- pronunciation: /rɪˈzɪliənt/\n- example: The system must remain resilient.\n\n## compose\n\n- meaning: 構成する\n- example: Compose your own sentence.\n`,
					);
		await this.app.workspace.getLeaf(false).openFile(file);
		new Notice(this.copy().noticeVocabularyCreated);
	}

	async select(id: string) {
		if (
			id === this.data.activeItemId ||
			!this.data.queue.some((item: ReadonlyQueueItem) => item.id === id)
		)
			return;
		this.transportGeneration += 1;
		this.resetPlaybackPresentation();
		this.data.activeItemId = id;
		if (this.data.upNextItemId === id) this.data.upNextItemId = null;
		await this.persist();
		this.refresh();
	}

	async selectChapter(id: string, chapterIndex: number) {
		const item = this.data.queue.find((candidate: ReadonlyQueueItem) => candidate.id === id);
		if (!item || !Number.isInteger(chapterIndex) || !item.chapters[chapterIndex]) return;
		if (id === this.data.activeItemId && chapterIndex === item.chapterIndex) return;
		this.transportGeneration += 1;
		this.resetPlaybackPresentation();
		this.data.activeItemId = id;
		if (this.data.upNextItemId === id) this.data.upNextItemId = null;
		item.chapterIndex = chapterIndex;
		await this.persist();
		this.refresh();
	}
	async playChapter(id: string, chapterIndex: number) {
		await this.selectChapter(id, chapterIndex);
		await this.playPause(id);
	}
	async setUpNext(id: string | null) {
		await setUpNextDurably(
			this.data,
			id,
			async () => {
				const durable = await this.persistCriticalResult();
				return durable;
			},
			async () => {
				await this.persist();
			},
		);
		this.refresh();
	}
	async reorderQueue(sourceId: string, targetId: string, placement: QueuePlacement) {
		const nextQueue = reorderQueueById(this.data.queue, sourceId, targetId, placement);
		const saved = await reorderQueueDurably(
			this.data,
			nextQueue,
			async () => {
				this.refresh();
				const durable = await this.persistCriticalResult();
				return durable;
			},
			async () => {
				await this.persist();
			},
		);
		this.refresh();
		return saved;
	}
	async remove(
		id: string,
		focusUndoView: Readonly<RenderableView> | null = null,
		nextVisibleItemId: string | null = null,
	) {
		const index = this.data.queue.findIndex((item: ReadonlyQueueItem) => item.id === id);
		const item = this.data.queue[index];
		if (!item) return;
		const wasActive = this.data.activeItemId === id;
		if (wasActive) {
			this.transportGeneration += 1;
			this.resetPlaybackPresentation();
		}
		this.data.queue = this.data.queue.filter((candidate: ReadonlyQueueItem) => candidate.id !== id);
		if (this.data.upNextItemId === id) this.data.upNextItemId = null;
		const nextVisibleExists = this.data.queue.some(
			(candidate: ReadonlyQueueItem) => candidate.id === nextVisibleItemId,
		);
		if (wasActive) {
			this.data.activeItemId = activeItemAfterRemoval(this.data.queue, index, nextVisibleItemId);
			if (this.data.upNextItemId === this.data.activeItemId) this.data.upNextItemId = null;
		}
		const returnFocusItemId =
			(nextVisibleExists ? nextVisibleItemId : null) ??
			this.data.queue[Math.min(index, this.data.queue.length - 1)]?.id ??
			null;
		this.removalUndo.record(item, index, wasActive, this.data.activeItemId, returnFocusItemId);
		this.removalUndoFocusView = focusUndoView;
		this.scheduleRemovalUndoExpiry();
		this.refresh();
		await this.persist();
	}

	latestRemovalUndo(
		view: Readonly<RenderableView>,
	): { id: string; title: string; focusUndo: boolean; returnFocusItemId: string | null } | null {
		const entry = this.removalUndo.latest();
		return entry
			? {
					id: entry.id,
					title: entry.item.title,
					focusUndo: this.removalUndoFocusView === view,
					returnFocusItemId: entry.returnFocusItemId,
				}
			: null;
	}

	async undoRemove(id: string) {
		const entry = this.removalUndo.take(id);
		this.removalUndoFocusView = null;
		this.scheduleRemovalUndoExpiry();
		if (!entry) {
			this.refresh();
			return;
		}
		this.refresh();

		const file = this.resolveQueueFile(entry.item.path);
		if (file?.extension !== "md") {
			new Notice(copyFor(this.data.settings.interfaceLanguage).undoUnavailable);
			this.refresh();
			return;
		}
		let markdown: string;
		try {
			markdown = await this.app.vault.cachedRead(file);
		} catch {
			new Notice(copyFor(this.data.settings.interfaceLanguage).undoUnavailable);
			this.refresh();
			return;
		}
		const chapters =
			(entry.item.kind ?? "note") === "drill"
				? vocabularyChapters(vocabularyFromMarkdown(markdown))
				: chaptersFromMarkdown(markdown, file.basename);
		if (!chapters.length) {
			new Notice(copyFor(this.data.settings.interfaceLanguage).undoUnavailable);
			this.refresh();
			return;
		}

		const restoredItem: QueueItem = {
			...entry.item,
			path: file.path,
			title: file.basename,
			chapters,
			coverUrl: this.coverUrl(file, markdown),
			chapterIndex: Math.max(0, Math.min(entry.item.chapterIndex, chapters.length - 1)),
			unavailable: false,
		};
		const restoredQueue = restoreRemovedItem(this.data.queue, entry, restoredItem);
		if (!restoredQueue) {
			new Notice(copyFor(this.data.settings.interfaceLanguage).undoUnavailable);
			this.refresh();
			return;
		}
		this.data.queue = restoredQueue;
		if (shouldRestoreRemovedAsActive(entry, this.data.activeItemId)) {
			this.transportGeneration += 1;
			this.resetPlaybackPresentation();
			this.data.activeItemId = entry.item.id;
		}
		this.refresh();
		await this.persist();
	}

	async dismissRemove(id: string) {
		this.removalUndo.take(id);
		this.removalUndoFocusView = null;
		this.scheduleRemovalUndoExpiry();
		this.refresh();
		await Promise.resolve();
	}

	async playPause(itemId?: string) {
		if (itemId !== undefined && itemId !== "" && itemId !== this.data.activeItemId) {
			const item = this.data.queue.find((candidate: ReadonlyQueueItem) => candidate.id === itemId);
			if (!item) return;
			this.transportGeneration += 1;
			this.resetPlaybackPresentation();
			this.data.activeItemId = item.id;
			if (this.data.upNextItemId === item.id) this.data.upNextItemId = null;
			await this.persist();
			this.refresh();
		}
		if (!this.active(itemId)) return;
		if (!this.player) {
			new Notice(this.copy().noticeSpeechUnavailable);
			return;
		}
		if (this.playerState === "playing") {
			this.pausePlayback();
			return;
		}
		this.playPlayback();
	}

	private playPlayback() {
		if (!this.player) return;
		if (this.playerState === "paused" && this.player.resume()) {
			this.playbackError = null;
			this.updateMediaSessionState("playing");
			return;
		}
		this.playCurrent();
	}

	private pausePlayback() {
		if (this.player?.pause() !== true) return;
		this.updateMediaSessionState("paused");
	}

	async previous(itemId?: string) {
		const item = this.active(itemId);
		if (!item) return;
		const generation = ++this.transportGeneration;
		this.cancelRecallTimer();
		this.player?.stop();
		item.chapterIndex = Math.max(0, item.chapterIndex - 1);
		await this.persist();
		if (generation !== this.transportGeneration) return;
		this.playCurrent();
		this.refresh();
	}
	async next(itemId?: string) {
		const item = this.active(itemId);
		if (!item) return;
		const generation = ++this.transportGeneration;
		this.cancelRecallTimer();
		this.player?.stop();
		if (item.chapterIndex < item.chapters.length - 1) item.chapterIndex += 1;
		else {
			item.completed = true;
			this.cancelRecallTimer();
			this.player?.stop();
			this.updateMediaSessionState("none");
			await this.persist();
			this.refresh();
			return;
		}
		await this.persist();
		if (generation !== this.transportGeneration) return;
		this.playCurrent();
		this.refresh();
	}
	restart(itemId?: string) {
		if (!this.active(itemId)) return;
		this.playCurrent();
	}
	async complete(itemId?: string) {
		const item = this.active(itemId);
		if (!item) return;
		this.transportGeneration += 1;
		this.cancelRecallTimer();
		item.completed = true;
		this.player?.stop();
		this.updateMediaSessionState("none");
		await this.persist();
		this.refresh();
	}
	async toggleLoop(itemId?: string) {
		const item = this.active(itemId);
		if (!item) return;
		item.loop = item.loop !== true;
		await this.persist();
		this.refresh();
	}
	async setRate(rate: number) {
		this.data.settings.rate = rate;
		await this.persist();
		this.refresh();
	}
	async updateSettings(settings: Readonly<Partial<SonoraSettings>>) {
		this.data.settings = { ...this.data.settings, ...settings };
		await this.persist();
		if (
			settings.recordingFolder !== undefined &&
			settings.recordingFolder !== "" &&
			!this.recording
		)
			this.syncRecordingRecoveryRoot();
	}
	refreshView() {
		this.refresh();
	}
	private copy() {
		return copyFor(this.data.settings.interfaceLanguage);
	}
	async openSource(itemId?: string) {
		const item = this.active(itemId);
		if (!item) return;
		const file = this.resolveQueueFile(item.path);
		if (file) await this.app.workspace.getLeaf(false).openFile(file);
	}

	async toggleRecording(itemId?: string) {
		const session = this.recordingSession;
		if (!session) return;
		if (session.currentPhase() === "recording") {
			session.stop();
			return;
		}
		if (session.currentPhase() !== "idle") return;
		if (
			navigator.mediaDevices?.getUserMedia === undefined ||
			typeof MediaRecorder === "undefined"
		) {
			this.recordingAccessIssue = "unsupported";
			this.refresh();
			return;
		}
		const item = this.active(itemId);
		if (!item) {
			new Notice(this.copy().noticeChooseRecordingNote);
			return;
		}
		this.transportGeneration += 1;
		this.cancelRecallTimer();
		const started = await session.start({ itemId: item.id, path: item.path, title: item.title });
		if (started && this.playerState === "playing") this.pausePlayback();
	}

	dismissRecordingIssue() {
		this.recordingAccessIssue = null;
		this.refresh();
	}

	private async saveRecording(payload: Readonly<RecordingPayload<RecordingContext>>) {
		const { context, blob, mimeType } = payload;
		if (!blob.size) return;
		const target = resolveRecordingTarget(context, this.data.queue);
		const copy = copyFor(this.data.settings.interfaceLanguage);
		const outcome = await saveRecordingPayload(
			{
				folder: this.data.settings.recordingFolder,
				title: target.title,
				sourcePath: target.path,
				blob,
				mimeType,
				appendVoiceMemoLink: this.data.settings.appendVoiceMemoLink,
				outputPath: payload.outputPath,
			},
			{
				normalizePath,
				now: () => new Date(),
				ensureFolder: async (folder) => {
					await this.ensureFolder(folder);
				},
				createBinary: async (path, data) => {
					const file = await this.app.vault.createBinary(path, data);
					return file;
				},
				exists: async (path) => {
					const exists = await this.app.vault.adapter.exists(path);
					return exists;
				},
				readBinary: async (path) => {
					const data = await this.app.vault.adapter.readBinary(path);
					return data;
				},
				appendToSource: async (sourcePath, content) => {
					const source = this.resolveQueueFile(sourcePath);
					if (!source) throw new Error(`Source note is unavailable: ${sourcePath}`);
					const audioPath = /!\[\[([^\]]+)\]\]/u.exec(content)?.[1];
					await this.app.vault.process(source, (markdown) =>
						audioPath !== undefined && audioPath !== "" && hasVoiceMemoLink(markdown, audioPath)
							? markdown
							: `${markdown}${content}`,
					);
				},
				preparePendingLink: async (audioPath, sourcePath) => {
					this.data.pendingVoiceMemoLinks = addPendingVoiceMemoLink(
						this.data.pendingVoiceMemoLinks,
						{ audioPath, sourcePath, createdAt: Date.now() },
					);
					await this.persistCritical();
				},
				clearPendingLink: async (audioPath, sourcePath) => {
					this.data.pendingVoiceMemoLinks = removePendingVoiceMemoLink(
						this.data.pendingVoiceMemoLinks,
						audioPath,
						sourcePath,
					);
					await this.persistCritical();
				},
			},
			(message) => {
				new Notice(message);
			},
			recordingSaveMessages(copy, payload.limit),
		);
		if (outcome.status === "failed") throw outcome.saveError;
	}

	private async enqueueRecordingSave(
		payload: Readonly<RecordingPayload<RecordingContext>>,
	): Promise<void> {
		if (!this.vaultEvents) {
			await this.saveRecording(payload);
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const accepted = this.vaultEvents?.enqueue(
				{ type: "recording-save", path: payload.context.path },
				async () => {
					try {
						await this.saveRecording(payload);
						resolve();
					} catch (error) {
						reject(error);
					}
				},
			);
			if (accepted !== true) reject(new Error("Sonora Vault event queue is closed"));
		});
	}

	private async recoverRecordings(): Promise<void> {
		for (const recovery of this.recordingRecoveries.values()) {
			for (const payload of await recovery.recover()) {
				try {
					await recovery.withClaim(
						payload.recoveryId,
						async () => {
							await this.saveRecording(payload);
						},
						async () => {
							await recovery.remove(payload.recoveryId);
						},
					);
				} catch {
					new Notice(this.copy().noticeRecordingFailed);
				}
			}
		}
	}

	private createRecordingRecovery(root: string): RecordingRecoveryStore<RecordingContext> {
		return new RecordingRecoveryStore<RecordingContext>({
			adapter: this.app.vault.adapter,
			root,
			installId: this.recordingRecoveryInstallId,
			ensureFolder: async (path) => {
				await this.ensureFolder(path);
			},
		});
	}

	private syncRecordingRecoveryRoot(): void {
		const root = normalizePath(`${this.data.settings.recordingFolder}/.sonora-pending`);
		this.rememberRecordingRoot(root);
		let recovery = this.recordingRecoveries.get(root);
		if (!recovery) {
			recovery = this.createRecordingRecovery(root);
			this.recordingRecoveries.set(root, recovery);
		}
		this.recordingRecovery = recovery;
	}

	private rememberRecordingRoot(current: string): string[] {
		try {
			return rememberRecordingRoot(this.app, current);
		} catch {
			return [current];
		}
	}

	private recordingInstallId(): string {
		try {
			return recordingInstallId(this.app, () => crypto.randomUUID());
		} catch {
			// This fallback intentionally changes after restart: an active session can
			// never be mistaken for a stale session owned by another installation.
			return crypto.randomUUID();
		}
	}

	private playCurrent() {
		this.cancelRecallTimer();
		this.transportGeneration += 1;
		const item = this.active();
		const chapter = item?.chapters[item.chapterIndex];
		if (!chapter || !this.player) return;
		item.lastPlayedAt = Date.now();
		void this.persist();
		if (item.completed) {
			item.completed = false;
			void this.persist();
		}
		this.playbackError = null;
		const language =
			this.data.settings.language === "system" ? navigator.language : this.data.settings.language;
		this.playbackStage = item.kind === "drill" ? "drill-prompt" : "chapter";
		this.spokenText =
			item.kind === "drill" ? chapter.heading : `${chapter.heading}. ${chapter.text}`;
		this.spokenOffset = 0;
		this.player.play(this.spokenText, {
			...this.data.settings,
			lang: language,
		});
		if ("mediaSession" in navigator && typeof MediaMetadata !== "undefined")
			navigator.mediaSession.metadata = new MediaMetadata({
				title: chapter.heading,
				artist: item.title,
				album: "Sonora",
			});
	}

	private async advanceAfterEnd(generation: number) {
		if (
			generation !== this.transportGeneration ||
			this.recording ||
			(this.playbackError !== null && this.playbackError !== "")
		)
			return;
		const item = this.active();
		if (!item) return;
		if (item.kind === "drill" && this.playbackStage === "drill-prompt") {
			this.playbackStage = "drill-answer";
			const itemId = item.id;
			const { chapterIndex } = item;
			this.recallTimer = window.setTimeout(() => {
				this.recallTimer = null;
				if (generation !== this.transportGeneration) return;
				const current = this.active();
				if (current?.id !== itemId || current.chapterIndex !== chapterIndex || this.recording)
					return;
				const chapter = current.chapters[chapterIndex];
				if (!chapter || !this.player) return;
				const language =
					this.data.settings.language === "system"
						? navigator.language
						: this.data.settings.language;
				this.spokenText = chapter.text;
				this.spokenOffset = 0;
				this.player.play(this.spokenText, { ...this.data.settings, lang: language });
				this.updateMediaSessionState("playing");
			}, this.data.settings.recallDelaySeconds * 1000);
			return;
		}
		if (item.kind !== "drill") {
			const result = await advanceListeningAfterEnd(
				this.data,
				item,
				async () => {
					const durable = await this.persistCriticalResult();
					return durable;
				},
				async () => {
					await this.persist();
				},
			);
			if (generation !== this.transportGeneration || this.recording) return;
			if (result.kind === "save-failed") {
				this.playbackError = this.copy().noticeSaveFailed;
				this.updateMediaSessionState("none");
				this.refresh();
				return;
			}
			if (result.kind === "next-chapter" || result.kind === "next-item") this.playCurrent();
			else this.updateMediaSessionState("none");
		} else if (item.loop === true) {
			item.chapterIndex = 0;
			item.completed = false;
			await this.persist();
			if (generation !== this.transportGeneration || this.recording) return;
			this.playCurrent();
		} else {
			item.completed = true;
			await this.persist();
			if (
				generation !== this.transportGeneration ||
				this.recording ||
				(this.playbackError !== null && this.playbackError !== "")
			)
				return;
			this.updateMediaSessionState("none");
		}
		this.refresh();
	}
	private active(itemId = this.data.activeItemId ?? undefined) {
		if (itemId !== (this.data.activeItemId ?? undefined)) return undefined;
		return (
			this.data.queue.find((item: ReadonlyQueueItem) => item.id === itemId) ?? this.data.queue[0]
		);
	}
	sourceFile(): TFile | null {
		const active = this.app.workspace.getActiveFile();
		if (active?.extension === "md") {
			this.lastMarkdownFile = active;
			return active;
		}
		if (
			this.lastMarkdownFile &&
			this.app.vault.getAbstractFileByPath(this.lastMarkdownFile.path) instanceof TFile
		)
			return this.lastMarkdownFile;
		return this.resolveInitialSourceFile();
	}
	private resolveInitialSourceFile(): TFile | null {
		for (const path of this.app.workspace.getLastOpenFiles()) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile && file.extension === "md") return file;
		}
		return null;
	}
	private refresh() {
		this.views.renderAll();
	}
	private scheduleRemovalUndoExpiry() {
		this.clearRemovalUndoTimer();
		const expiresAt = this.removalUndo.nextExpiry();
		if (expiresAt === null) return;
		this.removalUndoTimer = window.setTimeout(
			() => {
				this.removalUndoTimer = null;
				if (!this.removalUndo.latest()) this.removalUndoFocusView = null;
				this.refresh();
				this.scheduleRemovalUndoExpiry();
			},
			Math.max(0, expiresAt - Date.now()) + 1,
		);
	}
	private clearRemovalUndoTimer() {
		if (this.removalUndoTimer === null) return;
		window.clearTimeout(this.removalUndoTimer);
		this.removalUndoTimer = null;
	}
	private cancelRecallTimer() {
		if (this.recallTimer === null) return;
		window.clearTimeout(this.recallTimer);
		this.recallTimer = null;
	}
	private resetPlaybackPresentation() {
		this.cancelRecallTimer();
		this.player?.stop();
		this.spokenText = "";
		this.spokenOffset = 0;
		this.playbackError = null;
		this.updateMediaSessionState("none");
		if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
	}
	private async persist() {
		const snapshot = serializeData(this.data);
		await this.persistenceQueue?.save(snapshot);
	}
	private async persistCritical() {
		if (!(await this.persistCriticalResult()))
			throw new Error("Sonora data is not durably persisted");
	}
	private async persistCriticalResult(): Promise<boolean> {
		const snapshot = serializeData(this.data);
		return (await this.persistenceQueue?.saveCritical(snapshot)) ?? false;
	}
	private async retryPendingVoiceMemoLinks(notify: boolean) {
		let recovered = 0;
		let unavailable = 0;
		const retryBatch = Array.from(this.data.pendingVoiceMemoLinks);
		for (const pending of retryBatch) {
			const audio = this.app.vault.getAbstractFileByPath(pending.audioPath);
			if (!(audio instanceof TFile)) {
				// A File Provider placeholder can be temporarily absent during startup.
				// Explicit Vault delete events clear the intent; absence alone must not.
				unavailable += 1;
				continue;
			}
			const source = this.app.vault.getAbstractFileByPath(pending.sourcePath);
			if (!(source instanceof TFile) || source.extension !== "md") {
				unavailable += 1;
				continue;
			}
			try {
				const markdown = await this.app.vault.read(source);
				if (!hasVoiceMemoLink(markdown, pending.audioPath)) {
					await this.app.vault.append(source, voiceMemoLinkContent(pending.audioPath));
				}
				this.data.pendingVoiceMemoLinks = removePendingVoiceMemoLink(
					this.data.pendingVoiceMemoLinks,
					pending.audioPath,
					pending.sourcePath,
				);
				recovered += 1;
				await this.persist();
			} catch {
				unavailable += 1;
			}
		}
		if (!notify) return;
		const copy = this.copy();
		if (unavailable > 0) {
			new Notice(
				copy.noticeVoiceMemoLinksRemaining
					.replace("{recovered}", String(recovered))
					.replace("{remaining}", String(unavailable)),
			);
		} else {
			new Notice(copy.noticeVoiceMemoLinksRecovered.replace("{recovered}", String(recovered)));
		}
	}
	private async hydrateQueue() {
		const result = await hydrateQueueItems(
			this.data.queue,
			(path) => this.resolveQueueFile(path),
			async (item, file) => {
				await this.updateItemFromFile(item, file);
			},
		);
		return result;
	}
	private enqueueQueueHydration() {
		this.vaultEvents?.enqueue({ type: "hydrate", path: "/" }, async () => {
			const result = await this.hydrateQueue();
			this.stopIfActiveUnavailable();
			await this.persist();
			this.refresh();
			if (result.failed > 0) new Notice(this.copy().noticeQueueLoadFailed);
		});
	}
	private async initializeQueue() {
		await this.hydrateQueue();
		this.stopIfActiveUnavailable();
		await this.persist();
		this.refresh();
	}
	private async refreshFile(file: Readonly<TFile>) {
		if (!this.data.queue.some((item: ReadonlyQueueItem) => sameVaultPath(item.path, file.path)))
			return;
		const result = await this.refreshCoordinator?.refresh(file.path);
		if (!result || result.status === "stale") return;
		const items = this.data.queue.filter((item: ReadonlyQueueItem) =>
			sameVaultPath(item.path, file.path),
		);
		if (!items.length) return;
		if (items.some((item: ReadonlyQueueItem) => item.id === this.active()?.id)) {
			this.transportGeneration += 1;
			this.resetPlaybackPresentation();
		}
		for (const item of items) this.updateItemFromMarkdown(item, file, result.value);
		this.stopIfActiveUnavailable();
		await this.persist();
		this.refresh();
		this.refreshCoordinator?.forgetIfCurrent(file.path, result.generation);
	}
	private enqueueFileModify(file: Readonly<TFile>) {
		if (!this.vaultEvents) return;
		enqueueVaultModify(
			this.vaultEvents,
			file,
			(path) => {
				const current = this.app.vault.getAbstractFileByPath(path);
				return current instanceof TFile && current.extension === "md" ? current : null;
			},
			async (current) => {
				await this.refreshFile(current);
			},
			(path) => this.data.queue.some((item: ReadonlyQueueItem) => sameVaultPath(item.path, path)),
		);
	}
	private enqueueFileRename(file: Readonly<TFile>, oldPath: string) {
		if (!this.vaultEvents) return;
		enqueueVaultRename(
			this.vaultEvents,
			file,
			oldPath,
			(path) => {
				const current = this.app.vault.getAbstractFileByPath(path);
				return current instanceof TFile && current.extension === "md" ? current : null;
			},
			async (path, previousPath, current) => {
				await this.renameFile(path, previousPath, current);
			},
		);
	}
	private async renameFile(path: string, oldPath: string, file: Readonly<TFile> | null) {
		this.refreshCoordinator?.invalidate(oldPath);
		this.refreshCoordinator?.forget(oldPath);
		const basename = file?.basename ?? path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
		const renamedUndo = this.removalUndo.renamePath(oldPath, path, basename);
		const previousPending = this.data.pendingVoiceMemoLinks;
		this.data.pendingVoiceMemoLinks = renamePendingVoiceMemoPaths(previousPending, oldPath, path);
		const renamedPending = this.data.pendingVoiceMemoLinks.some(
			(item: Readonly<(typeof previousPending)[number]>, index) =>
				item.audioPath !== previousPending[index]?.audioPath ||
				item.sourcePath !== previousPending[index]?.sourcePath,
		);
		const items = this.data.queue.filter((item: ReadonlyQueueItem) =>
			sameVaultPath(item.path, oldPath),
		);
		if (!items.length) {
			if (renamedPending) await this.persist();
			if (renamedUndo) this.refresh();
			return;
		}
		for (const item of items) {
			item.path = path;
			item.title = basename;
		}
		if (file) {
			await this.refreshFile(file);
			return;
		}
		this.cancelRecallTimer();
		for (const item of items) {
			item.unavailable = true;
			item.chapters = [];
		}
		this.stopIfActiveUnavailable();
		await this.persist();
		this.refresh();
	}
	private async markFileUnavailable(path: string) {
		this.refreshCoordinator?.invalidate(path);
		this.refreshCoordinator?.forget(path);
		const pendingBefore = this.data.pendingVoiceMemoLinks.length;
		this.data.pendingVoiceMemoLinks = this.data.pendingVoiceMemoLinks.filter(
			(item: Readonly<(typeof this.data.pendingVoiceMemoLinks)[number]>) =>
				!sameVaultPath(item.audioPath, path),
		);
		const removedPending = pendingBefore !== this.data.pendingVoiceMemoLinks.length;
		const items = this.data.queue.filter((item: ReadonlyQueueItem) =>
			sameVaultPath(item.path, path),
		);
		if (!items.length) {
			if (removedPending) await this.persist();
			return;
		}
		this.cancelRecallTimer();
		for (const item of items) {
			item.unavailable = true;
			item.chapters = [];
		}
		this.stopIfActiveUnavailable();
		await this.persist();
		this.refresh();
	}
	private stopIfActiveUnavailable() {
		const item = this.active();
		if (item !== undefined && item.unavailable !== true && item.chapters.length > 0) return;
		this.transportGeneration += 1;
		this.cancelRecallTimer();
		this.player?.stop();
		this.spokenText = "";
		this.spokenOffset = 0;
		this.playbackError = null;
		this.updateMediaSessionState("none");
		if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
	}
	private async updateItemFromFile(item: QueueItem, file: Readonly<TFile>) {
		const markdown = await this.app.vault.cachedRead(file);
		this.updateItemFromMarkdown(item, file, markdown);
	}
	private updateItemFromMarkdown(item: QueueItem, file: Readonly<TFile>, markdown: string) {
		const chapters =
			item.kind === "drill"
				? vocabularyChapters(vocabularyFromMarkdown(markdown))
				: chaptersFromMarkdown(markdown, file.basename);
		item.title = file.basename;
		item.chapters = chapters;
		item.coverUrl = item.kind === "drill" ? undefined : this.coverUrl(file, markdown);
		item.unavailable = chapters.length === 0;
		item.loadError = false;
		item.chapterIndex = Math.min(item.chapterIndex, Math.max(0, chapters.length - 1));
	}
	private coverUrl(file: Readonly<TFile>, markdown: string): string | undefined {
		try {
			const reference = coverReferenceFromMarkdown(markdown);
			if (reference === null || reference === "") return undefined;
			if (/^(?:data:|https?:\/\/)/iu.test(reference)) return reference;
			const target = this.app.metadataCache.getFirstLinkpathDest(reference, file.path);
			return target ? this.app.vault.getResourcePath(target) : undefined;
		} catch {
			// Artwork is optional and must never make readable chapters unavailable.
			return undefined;
		}
	}
	private resolveQueueFile(path: string): TFile | null {
		const exact = this.app.vault.getAbstractFileByPath(path);
		if (exact instanceof TFile) return exact;
		return (
			this.app.vault
				.getMarkdownFiles()
				.find((file: Readonly<TFile>) => sameVaultPath(file.path, path)) ?? null
		);
	}
	private async ensureFolder(path: string) {
		let current = "";
		for (const segment of path.split("/").filter(Boolean)) {
			current = normalizePath(current ? `${current}/${segment}` : segment);
			if (!this.app.vault.getAbstractFileByPath(current))
				await this.app.vault.createFolder(current);
		}
	}
	private configureMediaSession() {
		if (!("mediaSession" in navigator)) return;
		const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
			[
				"play",
				() => {
					this.playPlayback();
				},
			],
			[
				"pause",
				() => {
					this.pausePlayback();
				},
			],
			["nexttrack", () => void this.next()],
			["previoustrack", () => void this.previous()],
		];
		for (const [action, handler] of handlers) {
			try {
				navigator.mediaSession.setActionHandler(action, handler);
			} catch {
				/* unsupported action */
			}
		}
	}
	private updateMediaSessionState(state: MediaSessionPlaybackState) {
		if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
	}
	private clearMediaSession() {
		if (!("mediaSession" in navigator)) return;
		for (const action of ["play", "pause", "nexttrack", "previoustrack"] as MediaSessionAction[]) {
			try {
				navigator.mediaSession.setActionHandler(action, null);
			} catch {
				/* unsupported action */
			}
		}
		navigator.mediaSession.playbackState = "none";
		navigator.mediaSession.metadata = null;
	}
}
