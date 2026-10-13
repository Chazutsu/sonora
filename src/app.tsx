import {
	Check,
	ChevronLeft,
	ChevronRight,
	FileAudio,
	Headphones,
	Languages,
	ListMusic,
	ListOrdered,
	ListPlus,
	ListEnd,
	Mic,
	MoreHorizontal,
	Pause,
	Play,
	Plus,
	RotateCcw,
	SlidersHorizontal,
	Square,
	Trash2,
	X,
} from "lucide-react";
import type { RecordingAccessIssue } from "./recording-access";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { SonoraCopy } from "./i18n";
import type { PlayerState } from "./player";
import { speechProgressLines } from "./progress-throttle";
import type { QueuePlacement } from "./queue-reorder";
import type { ReadonlyQueueItem, SonoraSettings } from "./types";
import { continueListening, queueSections, type QueueSections } from "./playback-information";

type LibraryFilter = "all" | "notes" | "drills";
type LibraryStatus = "all" | "unplayed" | "in-progress" | "completed";
type LibrarySort = "manual" | "recent" | "progress";

type ChapterMatch = { heading: string; index: number };
type EscapeKeyEvent = { readonly key: string; readonly preventDefault: () => void };
type PointerTargetEvent = { readonly target: unknown };
type ValueEvent = { readonly target: { readonly value: string } };
type PropagationEvent = { readonly stopPropagation: () => void };
type ClickDetailEvent = { readonly detail: number };
type ToggleEvent = { readonly currentTarget: { readonly open: boolean } };
type LibraryRowView = { readonly dataset: { readonly sonoraItemId?: string } };
type BlurContainmentEvent = {
	readonly currentTarget: { readonly contains: (target: Node | null) => boolean };
	readonly relatedTarget: Node | null;
};

function matchingChapter(item: ReadonlyQueueItem, query: string): ChapterMatch | null {
	if (!query || item.title.toLocaleLowerCase().includes(query)) return null;
	const index = item.chapters.findIndex((candidate) =>
		candidate.heading.toLocaleLowerCase().includes(query),
	);
	const chapter = item.chapters[index];
	return chapter ? { heading: chapter.heading, index } : null;
}

function handleMobileControlsKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
	const tabStops = Array.from(
		event.currentTarget.querySelectorAll<HTMLElement>(
			"button:not(:disabled), select:not(:disabled)",
		),
	);
	if (!tabStops.length) return;
	if (event.key === "Tab") {
		const target = event.target as HTMLElement;
		if (event.shiftKey && target === tabStops[0]) {
			event.preventDefault();
			tabStops.at(-1)?.focus();
		} else if (!event.shiftKey && target === tabStops.at(-1)) {
			event.preventDefault();
			tabStops[0]?.focus();
		}
		return;
	}
	if (event.target instanceof HTMLSelectElement) return;
	const controls = Array.from(
		event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
	);
	const current = controls.indexOf(
		event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
	);
	const next =
		event.key === "ArrowDown"
			? (current + 1 + controls.length) % controls.length
			: event.key === "ArrowUp"
				? (current - 1 + controls.length) % controls.length
				: event.key === "Home"
					? 0
					: event.key === "End"
						? controls.length - 1
						: -1;
	if (next < 0) return;
	event.preventDefault();
	controls[next]?.focus();
}

export type SonoraAppProps = {
	queue: readonly ReadonlyQueueItem[];
	activeItemId: string | null;
	upNextItemId: string | null;
	playerState: PlayerState;
	settings: Readonly<SonoraSettings>;
	recording: boolean;
	recordingRequesting: boolean;
	recordingAccessIssue: RecordingAccessIssue | null;
	playbackError: string | null;
	spokenText: string;
	spokenOffset: number;
	copy: Readonly<SonoraCopy>;
	removalUndo: Readonly<{
		id: string;
		title: string;
		focusUndo: boolean;
		returnFocusItemId: string | null;
	}> | null;
	onBrowseNotes: () => void;
	onBrowseVocabulary: () => void;
	onCreateVocabularyTemplate: () => void;
	onSelect: (id: string) => void;
	onSelectChapter: (id: string, chapterIndex: number) => void;
	onPlayChapter: (id: string, chapterIndex: number) => void;
	onSetUpNext: (id: string | null) => void;
	onReorder: (sourceId: string, targetId: string, placement: QueuePlacement) => Promise<boolean>;
	onRemove: (id: string, focusUndo: boolean, nextVisibleItemId: string | null) => void;
	onUndoRemove: (id: string) => void | Promise<void>;
	onDismissRemove: (id: string) => void | Promise<void>;
	onPlayPause: (id: string) => void;
	onPrevious: (id: string) => void;
	onNext: (id: string) => void;
	onRestart: (id: string) => void;
	onComplete: (id: string) => void;
	onToggleRecording: (id: string) => void;
	onDismissRecordingIssue: () => void;
	onRateChange: (rate: number) => void;
	onOpenSource: (id: string) => void;
	onToggleLoop: (id: string) => void;
};

export function activeItemAfterRemoval(
	queue: readonly ReadonlyQueueItem[],
	removedIndex: number,
	preferredItemId: string | null,
): string | null {
	if (
		preferredItemId !== null &&
		preferredItemId !== "" &&
		queue.some((item) => item.id === preferredItemId)
	)
		return preferredItemId;
	return queue[Math.min(removedIndex, queue.length - 1)]?.id ?? null;
}

function QueuePanel({
	sections,
	copy,
	onMove,
	onPlay,
	onSetNext,
}: Readonly<{
	sections: Readonly<QueueSections>;
	copy: Readonly<SonoraCopy>;
	onMove: (
		id: string,
		targetId: string,
		placement: QueuePlacement,
		direction: "up" | "down",
	) => void;
	onPlay: (id: string) => void;
	onSetNext: (id: string) => void;
}>) {
	const row = (item: ReadonlyQueueItem, status: string, actions = false, index = -1) => {
		const chapter = item.chapters[item.chapterIndex];
		const previous = sections.following[index - 1];
		const next = sections.following[index + 1];
		return (
			<li key={item.id} className="sonora-queue-row">
				<button
					type="button"
					className="sonora-queue-play"
					onClick={() => {
						onPlay(item.id);
					}}
				>
					<span className="sonora-queue-art">
						{item.coverUrl !== undefined ? (
							<img src={item.coverUrl} alt="" />
						) : (
							<Play size={17} fill="currentColor" />
						)}
					</span>
					<span>
						<strong>{chapter?.heading ?? item.title}</strong>
						<small>{item.title}</small>
					</span>
				</button>
				<span className="sonora-queue-status">{status}</span>
				{actions ? (
					<div className="sonora-queue-actions" aria-label={copy.queueOrderActions}>
						<button
							type="button"
							onClick={() => {
								onSetNext(item.id);
							}}
						>
							{copy.upNext}
						</button>
						<button
							type="button"
							disabled={!previous}
							aria-label={`${copy.moveUp} ${item.title}`}
							onClick={() => {
								if (previous) onMove(item.id, previous.id, "before", "up");
							}}
						>
							<ChevronLeft size={16} />
						</button>
						<button
							type="button"
							disabled={!next}
							aria-label={`${copy.moveDown} ${item.title}`}
							onClick={() => {
								if (next) onMove(item.id, next.id, "after", "down");
							}}
						>
							<ChevronRight size={16} />
						</button>
					</div>
				) : null}
			</li>
		);
	};
	return (
		<section className="sonora-queue-view" aria-label={copy.queue}>
			<section aria-labelledby="sonora-queue-current">
				<h3 id="sonora-queue-current">{copy.queueCurrent}</h3>
				<ol>
					{sections.current ? (
						row(sections.current, copy.nowPlaying)
					) : (
						<li className="sonora-queue-empty">{copy.queueNothingPlaying}</li>
					)}
				</ol>
			</section>
			<section aria-labelledby="sonora-queue-next">
				<h3 id="sonora-queue-next">{copy.queueNext}</h3>
				<ol>
					{sections.next ? (
						row(sections.next, copy.upNext)
					) : (
						<li className="sonora-queue-empty">{copy.queueNoNext}</li>
					)}
				</ol>
			</section>
			<section aria-labelledby="sonora-queue-following">
				<h3 id="sonora-queue-following">{copy.queueFollowing}</h3>
				<ol>
					{sections.following.length ? (
						sections.following.map((item, index) => row(item, `${index + 1}`, true, index))
					) : (
						<li className="sonora-queue-empty">{copy.queueNoFollowing}</li>
					)}
				</ol>
			</section>
			{sections.history.length ? (
				<section aria-labelledby="sonora-queue-history">
					<h3 id="sonora-queue-history">{copy.queueHistory}</h3>
					<ol>{sections.history.map((item) => row(item, copy.listened))}</ol>
				</section>
			) : null}
		</section>
	);
}

export function SonoraApp(props: Readonly<SonoraAppProps>) {
	const appRoot = useRef<HTMLElement>(null);
	const undoButton = useRef<HTMLButtonElement>(null);
	const undoHadFocus = useRef(false);
	const previousRemovalUndo = useRef<SonoraAppProps["removalUndo"]>(null);
	const [filter, setFilter] = useState<LibraryFilter>("all");
	const [queueOpen, setQueueOpen] = useState(false);
	const [libraryQuery, setLibraryQuery] = useState("");
	const [libraryStatus, setLibraryStatus] = useState<LibraryStatus>("all");
	const [librarySort, setLibrarySort] = useState<LibrarySort>("manual");
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
	const [mobileControlsForItemId, setMobileControlsForItemId] = useState<string | null>(null);
	const [rowMenuItemId, setRowMenuItemId] = useState<string | null>(null);
	const [detailItemId, setDetailItemId] = useState<string | null>(null);
	const [playerExpanded, setPlayerExpanded] = useState(false);
	const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
	const [reorderAnnouncement, setReorderAnnouncement] = useState("");
	const [desktopDnDEnabled, setDesktopDnDEnabled] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia?.("(min-width: 761px) and (pointer: fine)").matches === true,
	);
	const mobileAdd = useRef<HTMLDetailsElement>(null);
	const mobileAddTrigger = useRef<HTMLElement>(null);
	const mobileAddMenu = useRef<HTMLDivElement>(null);
	const mobileAddMenuId = useId();
	const mobileControlsTrigger = useRef<HTMLButtonElement>(null);
	const mobileControlsPopover = useRef<HTMLDivElement>(null);
	const mobileControlsId = useId();
	const mobileFiltersTrigger = useRef<HTMLButtonElement>(null);
	const mobileFiltersPopover = useRef<HTMLDivElement>(null);
	const mobileFiltersId = useId();
	const rowMenuTrigger = useRef<HTMLButtonElement>(null);
	const rowMenuPopover = useRef<HTMLDivElement>(null);
	const rowMenuId = useId();
	const filtered = useMemo(() => {
		const query = libraryQuery.trim().toLocaleLowerCase();
		const progress = (item: ReadonlyQueueItem) =>
			item.completed ? 1 : item.chapters.length > 0 ? item.chapterIndex / item.chapters.length : 0;
		return props.queue
			.filter(
				(item) =>
					filter === "all" || (filter === "drills" ? item.kind === "drill" : item.kind !== "drill"),
			)
			.filter((item) => {
				if (libraryStatus === "completed") return item.completed;
				if (libraryStatus === "in-progress") return !item.completed && item.chapterIndex > 0;
				if (libraryStatus === "unplayed") return !item.completed && item.chapterIndex === 0;
				return true;
			})
			.filter(
				(item) =>
					!query ||
					item.title.toLocaleLowerCase().includes(query) ||
					item.chapters.some((candidate) => candidate.heading.toLocaleLowerCase().includes(query)),
			)
			.toSorted((left, right) =>
				librarySort === "manual"
					? 0
					: librarySort === "progress"
						? progress(right) - progress(left) || right.addedAt - left.addedAt
						: right.addedAt - left.addedAt,
			);
	}, [filter, libraryQuery, librarySort, libraryStatus, props.queue]);
	const selected = props.queue.find((item) => item.id === props.activeItemId) ?? null;
	const mobileControlsOpen =
		mobileControlsForItemId !== null && mobileControlsForItemId === props.activeItemId;
	const active = selected;
	const chapter = active?.chapters[active.chapterIndex];
	const nextChapter = active?.chapters[active.chapterIndex + 1] ?? null;
	const upNext = props.queue.find((item) => item.id === props.upNextItemId) ?? null;
	const activeOutsideFilters = active !== null && !filtered.some((item) => item.id === active.id);
	const noteCount = props.queue.filter((item) => item.kind !== "drill").length;
	const drillCount = props.queue.filter((item) => item.kind === "drill").length;
	const { removalUndo } = props;
	const focusUndoId = removalUndo?.focusUndo === true ? removalUndo.id : null;
	const normalizedLibraryQuery = libraryQuery.trim().toLocaleLowerCase();
	const resumable = useMemo(() => continueListening(props.queue, 4), [props.queue]);
	const listeningQueue = useMemo(
		() => queueSections(props.queue, props.activeItemId, props.upNextItemId),
		[props.activeItemId, props.queue, props.upNextItemId],
	);
	const detailItem = props.queue.find((item) => item.id === detailItemId) ?? null;
	const expandedQueue = active
		? props.queue
				.filter((item) => item.id !== active.id && !item.completed)
				.toSorted((left, right) =>
					left.id === props.upNextItemId ? -1 : right.id === props.upNextItemId ? 1 : 0,
				)
				.slice(0, 3)
		: [];

	const focusLibraryItem = useCallback((itemId: string | null) => {
		window.requestAnimationFrame(() => {
			const root = appRoot.current;
			const row = Array.from(root?.querySelectorAll<HTMLElement>(".sonora-library-row") ?? []).find(
				(candidate: LibraryRowView) => candidate.dataset.sonoraItemId === itemId,
			);
			const target =
				row?.querySelector<HTMLElement>(".sonora-row-main") ??
				root?.querySelector<HTMLElement>(".sonora-content-header button");
			target?.focus();
		});
	}, []);

	const resetLibraryFilters = () => {
		setFilter("all");
		setLibraryQuery("");
		setLibraryStatus("all");
	};

	const showActiveInLibrary = () => {
		resetLibraryFilters();
		focusLibraryItem(active?.id ?? null);
	};

	const moveItem = useCallback(
		async (
			sourceId: string,
			targetId: string,
			placement: QueuePlacement,
			direction: "up" | "down",
		) => {
			const item = props.queue.find((candidate) => candidate.id === sourceId);
			if (!item) return;
			setLibrarySort("manual");
			const saved = await props.onReorder(sourceId, targetId, placement);
			setReorderAnnouncement(
				saved
					? (direction === "up" ? props.copy.movedUp : props.copy.movedDown).replace(
							"{title}",
							item.title,
						)
					: props.copy.moveFailed,
			);
			focusLibraryItem(sourceId);
		},
		[focusLibraryItem, props],
	);

	useEffect(() => {
		if (focusUndoId !== null && focusUndoId !== "") undoButton.current?.focus();
	}, [focusUndoId]);

	useEffect(() => {
		if (window.matchMedia === undefined) return;
		const query = window.matchMedia("(min-width: 761px) and (pointer: fine)");
		const update = () => {
			setDesktopDnDEnabled(query.matches);
		};
		update();
		query.addEventListener?.("change", update);
		return () => {
			query.removeEventListener?.("change", update);
		};
	}, []);

	useEffect(() => {
		const previous = previousRemovalUndo.current;
		previousRemovalUndo.current = removalUndo;
		if (!removalUndo && previous && undoHadFocus.current) {
			undoHadFocus.current = false;
			focusLibraryItem(previous.returnFocusItemId);
		}
	}, [focusLibraryItem, removalUndo]);

	const changeFilter = (next: LibraryFilter) => {
		setQueueOpen(false);
		setFilter(next);
	};

	const closeMobileAdd = useCallback((restoreFocus = false) => {
		mobileAdd.current?.removeAttribute("open");
		if (restoreFocus) mobileAddTrigger.current?.focus();
	}, []);

	const closeMobileControls = useCallback((restoreFocus = false) => {
		setMobileControlsForItemId(null);
		if (restoreFocus) mobileControlsTrigger.current?.focus();
	}, []);

	const closeMobileFilters = useCallback((restoreFocus = false) => {
		setMobileFiltersOpen(false);
		if (restoreFocus) mobileFiltersTrigger.current?.focus();
	}, []);

	const closeRowMenu = useCallback((restoreFocus = false) => {
		setRowMenuItemId(null);
		if (restoreFocus) rowMenuTrigger.current?.focus();
	}, []);

	useEffect(() => {
		const ownerDocument = mobileAdd.current?.ownerDocument;
		if (!ownerDocument) return () => undefined;
		const handleKeyDown = (event: EscapeKeyEvent) => {
			if (event.key !== "Escape" || mobileAdd.current?.open !== true) return;
			event.preventDefault();
			closeMobileAdd(true);
		};
		const handlePointerDown = (event: PointerTargetEvent) => {
			if (mobileAdd.current?.open !== true || mobileAdd.current.contains(event.target as Node))
				return;
			closeMobileAdd(true);
		};

		ownerDocument.addEventListener("keydown", handleKeyDown);
		ownerDocument.addEventListener("pointerdown", handlePointerDown);
		return () => {
			ownerDocument.removeEventListener("keydown", handleKeyDown);
			ownerDocument.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [closeMobileAdd]);

	useEffect(() => {
		if (!mobileControlsOpen) return;
		const ownerDocument = mobileControlsPopover.current?.ownerDocument;
		if (!ownerDocument) return;

		mobileControlsPopover.current
			?.querySelector<HTMLElement>("button:not(:disabled), select:not(:disabled)")
			?.focus();

		const handleKeyDown = (event: EscapeKeyEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeMobileControls(true);
		};
		const handlePointerDown = (event: PointerTargetEvent) => {
			const { target } = event;
			if (!(target instanceof Node)) return;
			if (
				mobileControlsPopover.current?.contains(target) === true ||
				mobileControlsTrigger.current?.contains(target) === true
			) {
				return;
			}
			closeMobileControls(false);
		};

		ownerDocument.addEventListener("keydown", handleKeyDown);
		ownerDocument.addEventListener("pointerdown", handlePointerDown);
		return () => {
			ownerDocument.removeEventListener("keydown", handleKeyDown);
			ownerDocument.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [closeMobileControls, mobileControlsOpen]);

	useEffect(() => {
		if (!mobileFiltersOpen) return;
		const ownerDocument = mobileFiltersPopover.current?.ownerDocument;
		if (!ownerDocument) return;
		mobileFiltersPopover.current?.querySelector<HTMLElement>("select")?.focus();
		const handleKeyDown = (event: EscapeKeyEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeMobileFilters(true);
		};
		const handlePointerDown = (event: PointerTargetEvent) => {
			const { target } = event;
			if (!(target instanceof Node)) return;
			if (
				mobileFiltersPopover.current?.contains(target) === true ||
				mobileFiltersTrigger.current?.contains(target) === true
			)
				return;
			closeMobileFilters(false);
		};
		ownerDocument.addEventListener("keydown", handleKeyDown);
		ownerDocument.addEventListener("pointerdown", handlePointerDown);
		return () => {
			ownerDocument.removeEventListener("keydown", handleKeyDown);
			ownerDocument.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [closeMobileFilters, mobileFiltersOpen]);

	useEffect(() => {
		if (rowMenuItemId === null || rowMenuItemId === "") return;
		const ownerDocument = rowMenuPopover.current?.ownerDocument;
		if (!ownerDocument) return;
		rowMenuPopover.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
		const handleKeyDown = (event: EscapeKeyEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			closeRowMenu(true);
		};
		const handlePointerDown = (event: PointerTargetEvent) => {
			const { target } = event;
			if (!(target instanceof Node)) return;
			if (
				rowMenuPopover.current?.contains(target) === true ||
				rowMenuTrigger.current?.contains(target) === true
			)
				return;
			closeRowMenu(false);
		};
		ownerDocument.addEventListener("keydown", handleKeyDown);
		ownerDocument.addEventListener("pointerdown", handlePointerDown);
		return () => {
			ownerDocument.removeEventListener("keydown", handleKeyDown);
			ownerDocument.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [closeRowMenu, rowMenuItemId]);

	const recordingIssueCopy = props.recordingAccessIssue
		? {
				denied: {
					title: props.copy.microphoneDeniedTitle,
					body: props.copy.microphoneDeniedBody,
				},
				unsupported: {
					title: props.copy.recordingUnsupportedTitle,
					body: props.copy.recordingUnsupportedBody,
				},
				transient: {
					title: props.copy.recordingTransientTitle,
					body: props.copy.recordingTransientBody,
				},
			}[props.recordingAccessIssue]
		: null;

	return (
		<main
			ref={appRoot}
			className={`sonora-app ${active ? "" : "is-empty"} ${playerExpanded ? "is-player-expanded" : ""}`}
		>
			<div className="sonora-sr-only" aria-live="polite" aria-atomic="true">
				{reorderAnnouncement}
			</div>
			<aside className="sonora-sidebar" aria-label={props.copy.navigation}>
				<div className="sonora-brand">
					<span className="sonora-brand-mark">
						<Headphones size={18} />
					</span>
					<strong>Sonora</strong>
				</div>
				<span className="sonora-sidebar-section-label">{props.copy.library}</span>
				<nav aria-label={props.copy.library}>
					<button
						className={queueOpen ? "is-active" : ""}
						aria-pressed={queueOpen}
						onClick={() => {
							setDetailItemId(null);
							setQueueOpen(true);
						}}
					>
						<ListOrdered size={18} />
						<span>{props.copy.queue}</span>
						<em>{listeningQueue.following.length + (listeningQueue.next ? 1 : 0)}</em>
					</button>
					<button
						className={filter === "all" ? "is-active" : ""}
						aria-pressed={filter === "all"}
						onClick={() => {
							changeFilter("all");
						}}
					>
						<ListMusic size={18} />
						<span>{props.copy.home}</span>
						<em>{props.queue.length}</em>
					</button>
					<button
						className={filter === "notes" ? "is-active" : ""}
						aria-pressed={filter === "notes"}
						onClick={() => {
							changeFilter("notes");
						}}
					>
						<FileAudio size={18} />
						<span>{props.copy.notes}</span>
						<em>{noteCount}</em>
					</button>
					<button
						className={filter === "drills" ? "is-active" : ""}
						aria-pressed={filter === "drills"}
						onClick={() => {
							changeFilter("drills");
						}}
					>
						<Languages size={18} />
						<span>{props.copy.languageDrills}</span>
						<em>{drillCount}</em>
					</button>
				</nav>
				<div className="sonora-sidebar-help">
					<strong>{props.copy.howToStart}</strong>
					<span>{props.copy.howToStartBody}</span>
				</div>
			</aside>

			<section className="sonora-content">
				{props.playbackError !== null && props.playbackError !== "" && (
					<div className="sonora-error" role="alert">
						{props.playbackError}
						<button
							onClick={() => {
								if (active) props.onRestart(active.id);
							}}
						>
							{props.copy.retry}
						</button>
					</div>
				)}
				<header className="sonora-content-header">
					<div>
						<h1>
							{queueOpen
								? props.copy.queue
								: filter === "drills"
									? props.copy.languageDrills
									: filter === "notes"
										? props.copy.listeningNotes
										: props.copy.goodListening}
						</h1>
						<p>
							{queueOpen
								? props.copy.queueSubtitle
								: filter === "drills"
									? props.copy.drillsSubtitle
									: props.copy.listeningSubtitle}
						</p>
					</div>
					{!queueOpen ? (
						<div className="sonora-add-actions">
							<button className="sonora-button" onClick={props.onBrowseVocabulary}>
								<Languages size={16} />
								{props.copy.addAsDrill}
							</button>
							<button className="sonora-button sonora-button-primary" onClick={props.onBrowseNotes}>
								<Plus size={17} />
								{props.copy.chooseNote}
							</button>
							<details
								className="sonora-mobile-add"
								ref={mobileAdd}
								onToggle={(event: ToggleEvent) => {
									if (!event.currentTarget.open) return;
									queueMicrotask(() => mobileAddMenu.current?.querySelector("button")?.focus());
								}}
							>
								<summary ref={mobileAddTrigger} aria-controls={mobileAddMenuId}>
									<Plus size={18} />
									{props.copy.add}
								</summary>
								<div id={mobileAddMenuId} ref={mobileAddMenu}>
									<button
										onClick={() => {
											closeMobileAdd(true);
											props.onBrowseNotes();
										}}
									>
										<FileAudio size={18} />
										{props.copy.listeningNote}
									</button>
									<button
										onClick={() => {
											closeMobileAdd(true);
											props.onBrowseVocabulary();
										}}
									>
										<Languages size={18} />
										{props.copy.drill}
									</button>
									<button
										onClick={() => {
											closeMobileAdd(true);
											props.onCreateVocabularyTemplate();
										}}
									>
										<ListPlus size={18} />
										{props.copy.vocabularyTemplate}
									</button>
								</div>
							</details>
						</div>
					) : null}
				</header>

				{props.queue.length === 0 ? (
					<div className="sonora-onboarding">
						<div className="sonora-onboarding-copy">
							<span className="sonora-disc">
								<ListMusic size={30} />
							</span>
							<h2>{props.copy.listenToWritten}</h2>
							<p>{props.copy.chooseMarkdown}</p>
						</div>
						<div className="sonora-start-options">
							<button className="is-primary" onClick={props.onBrowseNotes}>
								<span>
									<FileAudio size={21} />
								</span>
								<div>
									<strong>{props.copy.chooseListeningNote}</strong>
									<small>{props.copy.headingsBecomeChapters}</small>
								</div>
								<ChevronRight size={18} />
							</button>
							<button className="is-secondary" onClick={props.onBrowseVocabulary}>
								<span>
									<Languages size={21} />
								</span>
								<div>
									<strong>{props.copy.chooseVocabularyNote}</strong>
									<small>{props.copy.termPauseAnswer}</small>
								</div>
								<ChevronRight size={18} />
							</button>
							<button className="is-text-link" onClick={props.onCreateVocabularyTemplate}>
								<ListPlus size={16} />
								{props.copy.createVocabulary}
							</button>
						</div>
					</div>
				) : queueOpen ? (
					<QueuePanel
						sections={listeningQueue}
						copy={props.copy}
						onMove={(id, targetId, placement, direction) =>
							void moveItem(id, targetId, placement, direction)
						}
						onPlay={props.onPlayPause}
						onSetNext={(id) => {
							props.onSetUpNext(id);
						}}
					/>
				) : (
					<>
						{!detailItem && resumable.length > 0 && (
							<section className="sonora-continue" aria-labelledby="sonora-continue-title">
								<header>
									<h2 id="sonora-continue-title">{props.copy.continueListening}</h2>
									<span>{resumable.length}</span>
								</header>
								<div className="sonora-continue-list">
									{resumable.map((item) => {
										const current = item.chapters[item.chapterIndex];
										const isPlaying =
											item.id === props.activeItemId && props.playerState === "playing";
										const actionLabel = isPlaying
											? props.copy.pauseChapter
											: props.copy.resumeChapter;
										return (
											<button
												key={item.id}
												type="button"
												onClick={() => {
													props.onPlayPause(item.id);
												}}
												aria-label={actionLabel
													.replace("{title}", item.title)
													.replace("{chapter}", current?.heading ?? props.copy.readyToPlay)}
											>
												<span className="sonora-continue-play">
													{isPlaying ? (
														<Pause size={18} fill="currentColor" />
													) : (
														<Play size={18} fill="currentColor" />
													)}
												</span>
												<span>
													<strong>{item.title}</strong>
													<small>{current?.heading ?? props.copy.readyToPlay}</small>
												</span>
												<span className="sonora-continue-progress">
													{item.chapterIndex + 1}/{item.chapters.length}
												</span>
											</button>
										);
									})}
								</div>
							</section>
						)}
						{detailItem ? (
							<section className="sonora-note-detail" aria-labelledby="sonora-note-detail-title">
								<header>
									<button
										type="button"
										onClick={() => {
											setDetailItemId(null);
										}}
										aria-label={props.copy.backToLibrary}
									>
										<ChevronLeft size={18} />
										{props.copy.library}
									</button>
									<div>
										<h2 id="sonora-note-detail-title">{detailItem.title}</h2>
										<span>
											{detailItem.chapters.length} {props.copy.chapters}
										</span>
									</div>
								</header>
								<ol>
									{detailItem.chapters.map((detailChapter, index) => {
										const current = index === detailItem.chapterIndex && !detailItem.completed;
										const listened = detailItem.completed || index < detailItem.chapterIndex;
										const label = props.copy.playChapter.replace(
											"{chapter}",
											detailChapter.heading,
										);
										return (
											<li
												key={`${detailChapter.heading}-${index}`}
												className={current ? "is-current" : listened ? "is-listened" : ""}
											>
												<span className="sonora-chapter-index">
													{listened ? <Check size={15} /> : index + 1}
												</span>
												<button
													type="button"
													onClick={() => {
														props.onPlayChapter(detailItem.id, index);
													}}
												>
													<strong>{detailChapter.heading}</strong>
													<small>
														{current
															? props.copy.currentChapter
															: listened
																? props.copy.listened
																: props.copy.readyToPlay}
													</small>
												</button>
												<button
													type="button"
													className="sonora-chapter-play"
													onClick={() => {
														props.onPlayChapter(detailItem.id, index);
													}}
													aria-label={label}
												>
													<Play size={16} fill="currentColor" />
												</button>
											</li>
										);
									})}
								</ol>
							</section>
						) : (
							active &&
							chapter && (
								<LyricsCard
									readingNow={props.copy.readingNow}
									readyToRead={props.copy.readyToRead}
									lyricsView={props.copy.lyricsView}
									text={
										active.kind === "drill"
											? props.spokenText === chapter.text
												? chapter.text
												: chapter.heading
											: props.spokenText || `${chapter.heading}. ${chapter.text}`
									}
									offset={props.spokenOffset}
									playing={props.playerState === "playing"}
								/>
							)
						)}

						{!detailItem && (
							<>
								<div className="sonora-library-heading">
									<div>
										<h2>{props.copy.yourLibrary}</h2>
										<span>
											{filtered.length} {props.copy.items}
										</span>
									</div>
								</div>
								<div
									className="sonora-library-controls"
									role="search"
									aria-label={props.copy.searchLibrary}
								>
									<label className="sonora-library-search">
										<span>{props.copy.searchLibrary}</span>
										<input
											type="search"
											placeholder={props.copy.searchPlaceholder}
											value={libraryQuery}
											onChange={(event: ValueEvent) => {
												setLibraryQuery(event.target.value);
											}}
										/>
									</label>
									<button
										ref={mobileFiltersTrigger}
										className="sonora-filter-trigger"
										aria-label={props.copy.filterAndSort}
										aria-expanded={mobileFiltersOpen}
										aria-controls={mobileFiltersId}
										aria-haspopup="dialog"
										onClick={() => {
											if (mobileFiltersOpen) closeMobileFilters(true);
											else setMobileFiltersOpen(true);
										}}
									>
										<SlidersHorizontal size={17} />
										{props.copy.filterAndSort}
									</button>
									<div
										id={mobileFiltersId}
										ref={mobileFiltersPopover}
										className={`sonora-library-refinements ${mobileFiltersOpen ? "is-open" : ""}`}
										role={mobileFiltersOpen ? "dialog" : undefined}
										aria-label={mobileFiltersOpen ? props.copy.filterAndSort : undefined}
										aria-modal={mobileFiltersOpen ? "false" : undefined}
										onKeyDown={mobileFiltersOpen ? handleMobileControlsKeyDown : undefined}
									>
										<select
											aria-label={props.copy.statusFilter}
											value={libraryStatus}
											onChange={(event: ValueEvent) => {
												setLibraryStatus(event.target.value as LibraryStatus);
											}}
										>
											<option value="all">{props.copy.statusAll}</option>
											<option value="unplayed">{props.copy.statusUnplayed}</option>
											<option value="in-progress">{props.copy.statusInProgress}</option>
											<option value="completed">{props.copy.statusCompleted}</option>
										</select>
										<select
											aria-label={props.copy.sortLibrary}
											value={librarySort}
											onChange={(event: ValueEvent) => {
												setLibrarySort(event.target.value as LibrarySort);
											}}
										>
											<option value="manual">{props.copy.sortManual}</option>
											<option value="recent">{props.copy.sortRecent}</option>
											<option value="progress">{props.copy.sortProgress}</option>
										</select>
									</div>
								</div>
								{activeOutsideFilters && (
									<div
										className="sonora-filtered-active"
										role="status"
										aria-label={props.copy.activeOutsideFilters}
									>
										<span>{props.copy.outsideCurrentFilters}</span>
										<button type="button" onClick={showActiveInLibrary}>
											{props.copy.showActiveInLibrary}
										</button>
									</div>
								)}
								<div className="sonora-library" role="list">
									{filtered.map((item, index) => {
										const current = item.chapters[item.chapterIndex];
										const chapterMatch = matchingChapter(item, normalizedLibraryQuery);
										const isActive = item.id === active?.id;
										const nextVisibleItemId =
											filtered[index + 1]?.id ?? filtered[index - 1]?.id ?? null;
										const previousVisibleItem = filtered[index - 1];
										const followingVisibleItem = filtered[index + 1];
										return (
											<div
												key={item.id}
												className={`sonora-library-row ${isActive ? "is-active" : ""}`}
												role="listitem"
												data-sonora-item-id={item.id}
												draggable={desktopDnDEnabled && librarySort === "manual"}
												onDragStart={(event) => {
													setDraggedItemId(item.id);
													event.dataTransfer.effectAllowed = "move";
													event.dataTransfer.setData("text/plain", item.id);
												}}
												onDragEnd={() => {
													setDraggedItemId(null);
												}}
												onDragOver={(event) => {
													if (
														draggedItemId !== null &&
														draggedItemId !== "" &&
														draggedItemId !== item.id
													)
														event.preventDefault();
												}}
												onDrop={(event) => {
													event.preventDefault();
													if (
														draggedItemId === null ||
														draggedItemId === "" ||
														draggedItemId === item.id
													)
														return;
													const sourceIndex = filtered.findIndex(({ id }) => id === draggedItemId);
													const direction = sourceIndex < index ? "down" : "up";
													void moveItem(
														draggedItemId,
														item.id,
														direction === "down" ? "after" : "before",
														direction,
													);
													setDraggedItemId(null);
												}}
											>
												<div
													className="sonora-row-main"
													tabIndex={-1}
													aria-current={isActive ? "true" : undefined}
													onClick={() => {
														if (chapterMatch) props.onSelectChapter(item.id, chapterMatch.index);
														else props.onSelect(item.id);
													}}
												>
													<button
														type="button"
														className={`sonora-row-art ${item.kind === "drill" ? "is-drill" : ""}`}
														onClick={(event: PropagationEvent) => {
															event.stopPropagation();
															props.onPlayPause(item.id);
														}}
														aria-label={`${props.copy.play} ${item.title}`}
													>
														{item.kind === "drill" ? (
															<Languages size={20} />
														) : item.coverUrl !== undefined ? (
															<img src={item.coverUrl} alt="" />
														) : (
															<Play size={18} fill="currentColor" />
														)}
													</button>
													<button
														type="button"
														className="sonora-row-title"
														aria-label={
															chapterMatch
																? props.copy.openAtChapter
																		.replace("{title}", item.title)
																		.replace("{heading}", chapterMatch.heading)
																: undefined
														}
														onClick={(event: PropagationEvent) => {
															event.stopPropagation();
															if (chapterMatch) props.onSelectChapter(item.id, chapterMatch.index);
															else setDetailItemId(item.id);
														}}
													>
														<strong>{item.title}</strong>
														<span className="sonora-row-meta">
															<small>
																{chapterMatch
																	? props.copy.matchingChapter.replace(
																			"{heading}",
																			chapterMatch.heading,
																		)
																	: item.unavailable === true
																		? props.copy.sourceUnavailable
																		: (current?.heading ?? props.copy.readyToPlay)}
															</small>
															<span className="sonora-row-progress">
																{item.unavailable === true ? (
																	item.loadError === true ? (
																		props.copy.loadFailed
																	) : (
																		props.copy.unavailable
																	)
																) : item.completed ? (
																	<>
																		<Check size={14} /> {props.copy.listened}
																	</>
																) : (
																	`${item.chapterIndex + 1} / ${item.chapters.length}`
																)}
															</span>
														</span>
													</button>
												</div>
												<button
													className={`sonora-row-up-next ${item.id === upNext?.id ? "is-active" : ""}`}
													type="button"
													aria-label={props.copy.playNext.replace("{title}", item.title)}
													title={props.copy.playNext.replace("{title}", item.title)}
													aria-pressed={item.id === upNext?.id}
													disabled={isActive || item.completed}
													onClick={() => {
														props.onSetUpNext(item.id === upNext?.id ? null : item.id);
													}}
												>
													<ListEnd size={16} />
													<span>{props.copy.upNext}</span>
												</button>
												<button
													className="sonora-row-remove"
													onClick={(event: ClickDetailEvent) => {
														props.onRemove(item.id, event.detail === 0, nextVisibleItemId);
													}}
													aria-label={`${props.copy.remove} ${item.title}`}
												>
													<Trash2 size={16} />
												</button>
												<button
													ref={rowMenuItemId === item.id ? rowMenuTrigger : undefined}
													className="sonora-row-more"
													aria-label={props.copy.rowActions.replace("{title}", item.title)}
													aria-expanded={rowMenuItemId === item.id}
													aria-controls={rowMenuItemId === item.id ? rowMenuId : undefined}
													aria-haspopup="menu"
													onClick={(event) => {
														rowMenuTrigger.current = event.currentTarget;
														setRowMenuItemId(rowMenuItemId === item.id ? null : item.id);
													}}
												>
													<MoreHorizontal size={18} />
												</button>
												{rowMenuItemId === item.id && (
													<div
														id={rowMenuId}
														ref={rowMenuPopover}
														className="sonora-row-menu"
														role="menu"
														onKeyDown={handleMobileControlsKeyDown}
													>
														<button
															role="menuitem"
															disabled={!previousVisibleItem}
															onClick={() => {
																if (!previousVisibleItem) return;
																closeRowMenu(false);
																void moveItem(item.id, previousVisibleItem.id, "before", "up");
															}}
														>
															<ChevronLeft className="sonora-move-up-icon" size={16} />
															{props.copy.moveUp}
														</button>
														<button
															role="menuitem"
															disabled={!followingVisibleItem}
															onClick={() => {
																if (!followingVisibleItem) return;
																closeRowMenu(false);
																void moveItem(item.id, followingVisibleItem.id, "after", "down");
															}}
														>
															<ChevronRight className="sonora-move-down-icon" size={16} />
															{props.copy.moveDown}
														</button>
														<button
															role="menuitem"
															onClick={(event: ClickDetailEvent) => {
																closeRowMenu(false);
																props.onRemove(item.id, event.detail === 0, nextVisibleItemId);
															}}
														>
															<Trash2 size={16} />
															{props.copy.remove} {item.title}
														</button>
													</div>
												)}
											</div>
										);
									})}
									{filtered.length === 0 && (
										<div className="sonora-filter-empty" role="status">
											<p>{props.copy.nothingHere}</p>
											<button type="button" onClick={resetLibraryFilters}>
												{props.copy.clearLibraryFilters}
											</button>
										</div>
									)}
								</div>
							</>
						)}
					</>
				)}
			</section>

			{playerExpanded && active && chapter && (
				<section className="sonora-expanded-player" aria-labelledby="sonora-expanded-title">
					<header>
						<div>
							<span>{props.copy.nowPlaying}</span>
							<h2 id="sonora-expanded-title">{active.title}</h2>
							<dl className="sonora-expanded-context" aria-label={props.copy.playbackContext}>
								<div>
									<dt>{props.copy.currentChapter}</dt>
									<dd>{chapter.heading}</dd>
								</div>
								<div>
									<dt>{props.copy.nextChapterLabel}</dt>
									<dd>{nextChapter?.heading ?? props.copy.endOfNote}</dd>
								</div>
							</dl>
						</div>
						<button
							type="button"
							onClick={() => {
								setPlayerExpanded(false);
							}}
							aria-label={props.copy.closeNowPlaying}
						>
							<X size={20} />
						</button>
					</header>
					<div className="sonora-expanded-controls">
						<button
							type="button"
							onClick={() => {
								props.onPrevious(active.id);
							}}
							aria-label={props.copy.previous}
						>
							<ChevronLeft size={24} />
						</button>
						<button
							type="button"
							className="is-primary"
							onClick={() => {
								props.onPlayPause(active.id);
							}}
							aria-label={props.playerState === "playing" ? props.copy.pause : props.copy.play}
						>
							{props.playerState === "playing" ? (
								<Pause size={24} fill="currentColor" />
							) : (
								<Play size={24} fill="currentColor" />
							)}
						</button>
						<button
							type="button"
							onClick={() => {
								props.onNext(active.id);
							}}
							aria-label={props.copy.next}
						>
							<ChevronRight size={24} />
						</button>
					</div>
					<article aria-label={props.copy.chapterText}>
						<p>{chapter.text}</p>
					</article>
					<section aria-labelledby="sonora-expanded-next">
						<h3 id="sonora-expanded-next">{props.copy.nextInQueue}</h3>
						{expandedQueue.length ? (
							<ol>
								{expandedQueue.map((item) => (
									<li key={item.id}>
										<button
											type="button"
											onClick={() => {
												props.onPlayPause(item.id);
											}}
										>
											<strong>{item.chapters[item.chapterIndex]?.heading ?? item.title}</strong>
											<small>{item.title}</small>
										</button>
									</li>
								))}
							</ol>
						) : (
							<p className="sonora-expanded-empty">{props.copy.emptyQueue}</p>
						)}
					</section>
					<button
						type="button"
						className="sonora-expanded-source"
						onClick={() => {
							props.onOpenSource(active.id);
						}}
					>
						{props.copy.openSource}
					</button>
				</section>
			)}

			{active && chapter && (
				<footer className="sonora-player">
					<>
						{recordingIssueCopy && (
							<section
								className="sonora-recording-issue"
								role="alert"
								aria-busy={props.recordingRequesting}
							>
								<div>
									<strong>{recordingIssueCopy.title}</strong>
									<p>{recordingIssueCopy.body}</p>
								</div>
								<div className="sonora-recording-issue-actions">
									{props.recordingAccessIssue !== "unsupported" && (
										<button
											type="button"
											disabled={props.recordingRequesting}
											onClick={() => {
												props.onToggleRecording(active.id);
											}}
										>
											{props.recordingRequesting
												? props.copy.recordingRequesting
												: props.copy.retry}
										</button>
									)}
									<button
										type="button"
										className="sonora-recording-issue-dismiss"
										onClick={props.onDismissRecordingIssue}
										aria-label={props.copy.dismissRecordingIssue}
									>
										<X size={18} />
									</button>
								</div>
							</section>
						)}
						<div className="sonora-player-track-shell">
							<button
								className="sonora-player-track"
								onClick={() => {
									setPlayerExpanded(true);
								}}
								aria-expanded={playerExpanded}
							>
								<span className={`sonora-player-art ${active.kind === "drill" ? "is-drill" : ""}`}>
									{active.kind === "drill" ? (
										<Languages size={22} />
									) : active.coverUrl !== undefined ? (
										<img src={active.coverUrl} alt="" />
									) : (
										<FileAudio size={22} />
									)}
								</span>
								<span>
									<strong>{chapter.heading}</strong>
									<small>{active.title}</small>
								</span>
							</button>
							{upNext && (
								<div className="sonora-player-up-next">
									<span>{props.copy.upNext}</span>
									<strong>{upNext.title}</strong>
									<button
										type="button"
										onClick={() => {
											props.onSetUpNext(null);
										}}
										aria-label={props.copy.clearUpNext}
									>
										<X size={14} />
									</button>
								</div>
							)}
						</div>
						<div className="sonora-player-center">
							<div className="sonora-player-controls">
								{active.kind === "drill" && (
									<button
										className={`sonora-control-loop ${active.loop === true ? "is-on" : ""}`}
										onClick={() => {
											props.onToggleLoop(active.id);
										}}
										aria-label={props.copy.loop}
										aria-pressed={active.loop === true}
									>
										<RotateCcw size={16} />
									</button>
								)}
								<button
									className="sonora-player-previous"
									onClick={() => {
										props.onPrevious(active.id);
									}}
									aria-label={props.copy.previous}
								>
									<ChevronLeft size={21} />
								</button>
								<button
									className="sonora-player-play"
									onClick={() => {
										props.onPlayPause(active.id);
									}}
									aria-label={props.playerState === "playing" ? props.copy.pause : props.copy.play}
								>
									{props.playerState === "playing" ? (
										<Pause size={20} fill="currentColor" />
									) : (
										<Play size={20} fill="currentColor" />
									)}
								</button>
								<button
									className="sonora-player-next"
									onClick={() => {
										props.onNext(active.id);
									}}
									aria-label={props.copy.next}
								>
									<ChevronRight size={21} />
								</button>
								<button
									className="sonora-control-restart"
									onClick={() => {
										props.onRestart(active.id);
									}}
									aria-label={props.copy.restart}
								>
									<RotateCcw size={16} />
								</button>
							</div>
							<div
								className="sonora-player-progress"
								role="progressbar"
								aria-valuemin={1}
								aria-valuemax={active.chapters.length}
								aria-valuenow={active.chapterIndex + 1}
								aria-valuetext={`${props.copy.chapter} ${active.chapterIndex + 1} ${props.copy.of} ${active.chapters.length}`}
								aria-label={`${props.copy.chapter} ${active.chapterIndex + 1} ${props.copy.of} ${active.chapters.length}`}
							>
								<span>{active.chapterIndex + 1}</span>
								<div>
									<i
										style={{
											width: `${((active.chapterIndex + 1) / active.chapters.length) * 100}%`,
										}}
									/>
								</div>
								<span>{active.chapters.length}</span>
							</div>
						</div>
						<div className="sonora-player-tools">
							<select
								aria-label={props.copy.speed}
								value={props.settings.rate}
								onChange={(event: ValueEvent) => {
									props.onRateChange(Number(event.target.value));
								}}
							>
								{[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
									<option key={rate} value={rate}>
										{rate}×
									</option>
								))}
							</select>
							<button
								className={`sonora-record ${props.recording ? "is-recording" : ""}`}
								onClick={() => {
									props.onToggleRecording(active.id);
								}}
								disabled={props.recordingRequesting}
								aria-busy={props.recordingRequesting}
							>
								{props.recording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
								<span>{props.recording ? props.copy.save : props.copy.respond}</span>
							</button>
							<button
								className="sonora-complete"
								onClick={() => {
									props.onComplete(active.id);
								}}
								aria-label={props.copy.markListened}
								disabled={active.completed}
							>
								<Check size={18} />
								<span>{props.copy.listened}</span>
							</button>
							<button
								ref={mobileControlsTrigger}
								className="sonora-player-more"
								aria-label={props.copy.moreControls}
								aria-expanded={mobileControlsOpen}
								aria-controls={mobileControlsId}
								aria-haspopup="dialog"
								onClick={() => {
									if (mobileControlsOpen) closeMobileControls(true);
									else setMobileControlsForItemId(props.activeItemId);
								}}
							>
								<MoreHorizontal size={20} />
							</button>
						</div>
						{mobileControlsOpen && (
							<div
								id={mobileControlsId}
								ref={mobileControlsPopover}
								className="sonora-mobile-actions"
								role="dialog"
								aria-modal="false"
								aria-label={props.copy.moreControls}
								onKeyDown={handleMobileControlsKeyDown}
							>
								{active.kind === "drill" && (
									<button
										className={active.loop === true ? "is-on" : ""}
										onClick={() => {
											props.onToggleLoop(active.id);
										}}
										aria-pressed={active.loop === true}
									>
										<RotateCcw size={18} />
										{props.copy.loop}
									</button>
								)}
								<button
									onClick={() => {
										props.onRestart(active.id);
									}}
								>
									<RotateCcw size={18} />
									{props.copy.restartShort}
								</button>
								<label>
									<span>{props.copy.speed}</span>
									<select
										value={props.settings.rate}
										onChange={(event: ValueEvent) => {
											props.onRateChange(Number(event.target.value));
										}}
									>
										{[0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
											<option key={rate} value={rate}>
												{rate}×
											</option>
										))}
									</select>
								</label>
								<button
									className={props.recording ? "is-recording" : ""}
									onClick={() => {
										props.onToggleRecording(active.id);
									}}
									disabled={props.recordingRequesting}
									aria-busy={props.recordingRequesting}
								>
									{props.recording ? <Square size={17} fill="currentColor" /> : <Mic size={18} />}
									{props.recording ? props.copy.saveResponse : props.copy.recordResponse}
								</button>
								<button
									onClick={() => {
										props.onComplete(active.id);
									}}
									disabled={active.completed}
								>
									<Check size={18} />
									{props.copy.markListened}
								</button>
								{upNext && (
									<button
										onClick={() => {
											props.onSetUpNext(null);
										}}
									>
										<ListEnd size={18} />
										{props.copy.upNext}: {upNext.title}
									</button>
								)}
							</div>
						)}
					</>
				</footer>
			)}
			{removalUndo && (
				<div
					className="sonora-undo"
					role="region"
					aria-label={props.copy.undo}
					onFocusCapture={() => {
						undoHadFocus.current = true;
					}}
					onBlurCapture={(event: BlurContainmentEvent) => {
						if (!event.currentTarget.contains(event.relatedTarget)) {
							undoHadFocus.current = false;
						}
					}}
				>
					<span role="status" aria-live="polite">
						{props.copy.removedFromLibrary.replace("{title}", removalUndo.title)}
					</span>
					<button
						ref={undoButton}
						type="button"
						onClick={() => {
							void Promise.resolve(props.onUndoRemove(removalUndo.id)).then(() => {
								focusLibraryItem(removalUndo.id);
							});
						}}
					>
						{props.copy.undo}
					</button>
					<button
						type="button"
						className="sonora-undo-dismiss"
						aria-label={props.copy.dismissUndo}
						onClick={() => {
							void Promise.resolve(props.onDismissRemove(removalUndo.id)).then(() => {
								focusLibraryItem(removalUndo.returnFocusItemId);
							});
						}}
					>
						<X size={18} />
					</button>
				</div>
			)}
		</main>
	);
}

export function activeLyricIndex(lines: readonly string[], offset: number): number {
	if (!lines.length) return -1;
	let cursor = 0;
	const index = lines.findIndex((line) => {
		cursor += line.length;
		return offset < cursor;
	});
	return index === -1 ? lines.length - 1 : index;
}

export function LyricsCard({
	title,
	kind,
	readingNow = "Reading now",
	readyToRead = "Ready to read",
	lyricsView = "Lyrics view",
	text,
	offset,
	playing,
}: Readonly<{
	title?: string;
	kind?: string;
	readingNow?: string;
	readyToRead?: string;
	lyricsView?: string;
	text: string;
	offset: number;
	playing: boolean;
}>) {
	const lines = speechProgressLines(text);
	const activeIndex = activeLyricIndex(lines, offset);
	const activeLine = lines[activeIndex] ?? "";
	const contextStart = Math.max(0, activeIndex - 1);
	const contextEnd = Math.min(lines.length, activeIndex + 2);
	const contextLines = lines.slice(contextStart, contextEnd);
	const currentLine = useRef<HTMLParagraphElement>(null);
	const linesContainer = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const container = linesContainer.current;
		const line = currentLine.current;
		if (!container || !line || !activeLine || activeIndex < 0) return;
		const containerRect = container.getBoundingClientRect();
		const lineRect = line.getBoundingClientRect();
		const reduceMotion =
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		container.scrollTo({
			top:
				container.scrollTop +
				lineRect.top -
				containerRect.top -
				container.clientHeight / 2 +
				lineRect.height / 2,
			behavior: reduceMotion ? "auto" : "smooth",
		});
	}, [activeIndex, activeLine]);
	return (
		<section className="sonora-lyrics" aria-label={lyricsView}>
			<div className="sonora-lyrics-heading">
				<span>
					{title !== undefined && title !== ""
						? `${playing ? readingNow : readyToRead} · ${title}`
						: playing
							? readingNow
							: readyToRead}
				</span>
				{kind !== undefined && kind !== "" && <em>{kind}</em>}
			</div>
			<div className="sonora-lyrics-lines" ref={linesContainer}>
				{contextLines.map((line, contextIndex) => {
					const index = contextStart + contextIndex;
					return (
						<p
							ref={index === activeIndex ? currentLine : undefined}
							key={`${index}-${line}`}
							className={
								index === activeIndex ? "is-current" : index < activeIndex ? "is-read" : ""
							}
							aria-current={index === activeIndex ? "true" : undefined}
						>
							{line.trim()}
						</p>
					);
				})}
			</div>
		</section>
	);
}
