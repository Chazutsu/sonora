import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SonoraApp, activeItemAfterRemoval, type SonoraAppProps } from "../src/app";
import { copyFor } from "../src/i18n";
import { DEFAULT_SETTINGS } from "../src/types";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	HTMLElement.prototype.scrollTo = vi.fn();
});

function renderApp(overrides: Partial<SonoraAppProps> = {}) {
	const noop = vi.fn();
	const props: SonoraAppProps = {
		queue: [],
		activeItemId: null,
		upNextItemId: null,
		playerState: "idle",
		settings: DEFAULT_SETTINGS,
		recording: false,
		recordingRequesting: false,
		recordingAccessIssue: null,
		playbackError: null,
		spokenText: "",
		spokenOffset: 0,
		copy: copyFor("en", "en-US"),
		removalUndo: null,
		onBrowseNotes: noop,
		onBrowseVocabulary: noop,
		onCreateVocabularyTemplate: noop,
		onSelect: noop,
		onSelectChapter: noop,
		onPlayChapter: noop,
		onSetUpNext: noop,
		onReorder: vi.fn().mockResolvedValue(true),
		onRemove: noop,
		onUndoRemove: noop,
		onDismissRemove: noop,
		onPlayPause: noop,
		onPrevious: noop,
		onNext: noop,
		onRestart: noop,
		onComplete: noop,
		onToggleRecording: noop,
		onDismissRecordingIssue: noop,
		onRateChange: noop,
		onOpenSource: noop,
		onToggleLoop: noop,
		...overrides,
	};

	return { ...render(<SonoraApp {...props} />), props };
}

describe("SonoraApp empty library", () => {
	it("presents one primary action, one secondary action, and a template text action", () => {
		renderApp();
		const root = document.querySelector(".sonora-app");
		expect(root?.classList.contains("is-empty")).toBe(true);
		const actions = document.querySelector(".sonora-start-options");
		expect(actions?.querySelectorAll("button")).toHaveLength(3);
		expect(actions?.querySelector(".is-primary")?.textContent).toContain(
			"Choose a note to listen to",
		);
		expect(actions?.querySelector(".is-secondary")?.textContent).toContain(
			"Choose a vocabulary note",
		);
		expect(actions?.querySelector(".is-text-link")?.textContent).toContain(
			"Create a vocabulary starter",
		);
	});
});

function openAddMenu() {
	const trigger = screen.getByText("Add", { selector: "summary" });
	const details = trigger.closest("details");
	if (!details) throw new Error("Add menu details not found");
	details.open = true;
	fireEvent(details, new Event("toggle"));
	return { details, trigger };
}

const firstQueueItem = {
	id: "first",
	path: "First.md",
	title: "First",
	chapters: [{ heading: "Chapter one", level: 1, text: "Listen." }],
	chapterIndex: 0,
	completed: false,
	addedAt: 1,
	kind: "note" as const,
};

const secondQueueItem = {
	...firstQueueItem,
	id: "second",
	path: "Second.md",
	title: "Second",
};

describe("SonoraApp continue listening", () => {
	it("lastPlayedAt順に未完了項目を表示し1操作で再生する", () => {
		const onPlayPause = vi.fn();
		renderApp({
			queue: [
				{ ...firstQueueItem, lastPlayedAt: 10 },
				{ ...secondQueueItem, lastPlayedAt: 20 },
				{ ...firstQueueItem, id: "done", title: "Done", completed: true, lastPlayedAt: 30 },
			],
			activeItemId: "first",
			onPlayPause,
		});

		const section = screen.getByRole("region", { name: "Continue listening" });
		const buttons = within(section).getAllByRole("button");
		expect(buttons.map((button) => button.textContent)).toEqual([
			"SecondChapter one1/1",
			"FirstChapter one1/1",
		]);
		fireEvent.click(buttons[0]!);
		expect(onPlayPause).toHaveBeenCalledWith("second");
	});
});

describe("SonoraApp queue", () => {
	it("現在・次・後続・履歴を分け、後続を明示操作できる", async () => {
		const third = { ...firstQueueItem, id: "third", title: "Third" };
		const fourth = { ...firstQueueItem, id: "fourth", title: "Fourth" };
		const completed = {
			...firstQueueItem,
			id: "done",
			title: "Done",
			completed: true,
			lastPlayedAt: 20,
		};
		const onReorder = vi.fn().mockResolvedValue(true);
		const onSetUpNext = vi.fn();
		renderApp({
			queue: [firstQueueItem, secondQueueItem, third, fourth, completed],
			activeItemId: firstQueueItem.id,
			upNextItemId: secondQueueItem.id,
			onReorder,
			onSetUpNext,
		});
		fireEvent.click(screen.getByRole("button", { name: /Queue/u }));
		expect(
			within(screen.getByRole("region", { name: "Playing now" })).getByText("First"),
		).not.toBeNull();
		expect(within(screen.getByRole("region", { name: "Next" })).getByText("Second")).not.toBeNull();
		const later = screen.getByRole("region", { name: "Later" });
		expect(within(later).getAllByRole("listitem")).toHaveLength(2);
		fireEvent.click(within(later).getByRole("button", { name: "Move down Third" }));
		await waitFor(() => expect(onReorder).toHaveBeenCalledWith("third", "fourth", "after"));
		fireEvent.click(within(later).getAllByRole("button", { name: "Up next" })[0]!);
		expect(onSetUpNext).toHaveBeenCalledWith("third");
		expect(
			within(screen.getByRole("region", { name: "Listening history" })).getByText("Done"),
		).not.toBeNull();
	});
});

describe("SonoraApp note detail", () => {
	it("タイトルからChapter一覧を開き、Chapterを直接再生して戻れる", () => {
		const onPlayChapter = vi.fn();
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id, onPlayChapter });
		fireEvent.click(screen.getByRole("button", { name: /FirstChapter one/u }));
		expect(screen.getByRole("heading", { name: "First" })).not.toBeNull();
		expect(screen.queryByRole("heading", { name: "Your library" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Play Chapter one" }));
		expect(onPlayChapter).toHaveBeenCalledWith("first", 0);
		fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
		expect(screen.getByRole("heading", { name: "Your library" })).not.toBeNull();
	});

	it("左の再生ボタンは詳細を開かず1操作で再生する", () => {
		const onPlayPause = vi.fn();
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id, onPlayPause });
		fireEvent.click(screen.getByRole("button", { name: "Play First" }));
		expect(onPlayPause).toHaveBeenCalledWith("first");
		expect(screen.queryByRole("button", { name: "Back to library" })).toBeNull();
	});
});

describe("SonoraApp expanded player", () => {
	it("compact playerから本文と次の3件を同じ再生状態で開く", () => {
		const active = {
			...firstQueueItem,
			chapters: [
				...firstQueueItem.chapters,
				{ heading: "Chapter two", level: 1, text: "Continue." },
			],
		};
		const third = { ...firstQueueItem, id: "third", title: "Third" };
		renderApp({
			queue: [active, secondQueueItem, third],
			activeItemId: active.id,
			upNextItemId: secondQueueItem.id,
		});
		fireEvent.click(screen.getByRole("button", { name: /Chapter oneFirst/u }));
		expect(screen.getByRole("heading", { name: "First" })).not.toBeNull();
		const context = screen.getByText("Current chapter", { selector: "dt" }).parentElement;
		expect(context?.textContent).toContain("Chapter one");
		expect(
			screen.getByText("Next chapter", { selector: "dt" }).parentElement?.textContent,
		).toContain("Chapter two");
		expect(screen.getByRole("article", { name: "Chapter text" }).textContent).toContain("Listen.");
		const next = screen.getByRole("region", { name: "Next in queue" });
		expect(within(next).getAllByRole("listitem")).toHaveLength(2);
		expect(within(next).getAllByRole("listitem")[0]?.textContent).toContain("Second");
		fireEvent.click(screen.getByRole("button", { name: "Close Now Playing" }));
		expect(screen.queryByRole("article", { name: "Chapter text" })).toBeNull();
	});
});

function openMobileControls() {
	const trigger = screen.getByRole("button", { name: "More playback controls" });
	fireEvent.click(trigger);
	const popover = screen.getByRole("dialog", { name: "More playback controls" });
	return { popover, trigger };
}

describe("SonoraApp mobile add menu", () => {
	it("links the trigger to the menu and focuses the first action when opened", async () => {
		renderApp();
		const { trigger } = openAddMenu();
		const menuId = trigger.getAttribute("aria-controls");

		expect(menuId).toBeTruthy();
		expect(document.getElementById(menuId ?? "")).not.toBeNull();
		await waitFor(() => expect(document.activeElement?.textContent).toContain("Listening note"));
	});

	it("closes on Escape and restores focus to the trigger", async () => {
		renderApp();
		const { details, trigger } = openAddMenu();
		await waitFor(() => expect(document.activeElement?.textContent).toContain("Listening note"));

		fireEvent.keyDown(document, { key: "Escape" });

		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on an outside pointer interaction and restores focus", async () => {
		renderApp();
		const { details, trigger } = openAddMenu();
		await waitFor(() => expect(document.activeElement?.textContent).toContain("Listening note"));

		fireEvent.pointerDown(document.body);

		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(trigger);
	});

	it("closes after choosing an action and restores focus before opening the picker", async () => {
		const onBrowseNotes = vi.fn();
		renderApp({ onBrowseNotes });
		const { details, trigger } = openAddMenu();
		const action = await screen.findByRole("button", { name: "Listening note" });

		fireEvent.click(action);

		expect(details.open).toBe(false);
		expect(document.activeElement).toBe(trigger);
		expect(onBrowseNotes).toHaveBeenCalledOnce();
	});
});

describe("SonoraApp mobile playback controls", () => {
	const activeProps = {
		queue: [firstQueueItem, secondQueueItem],
		activeItemId: firstQueueItem.id,
	};

	it("links a named non-modal popover and focuses its first action", async () => {
		renderApp(activeProps);
		const { popover, trigger } = openMobileControls();

		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(trigger.getAttribute("aria-controls")).toBe(popover.id);
		expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
		expect(popover.getAttribute("aria-modal")).toBe("false");
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restart" })),
		);
	});

	it("closes on Escape and restores focus to the trigger", async () => {
		renderApp(activeProps);
		const { trigger } = openMobileControls();
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));

		fireEvent.keyDown(document, { key: "Escape" });

		expect(screen.queryByRole("dialog", { name: "More playback controls" })).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
	});

	it("closes from its trigger and restores focus to it", async () => {
		renderApp(activeProps);
		const { trigger } = openMobileControls();
		await waitFor(() => expect(document.activeElement).not.toBe(trigger));

		fireEvent.click(trigger);

		expect(screen.queryByRole("dialog", { name: "More playback controls" })).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("closes on an outside pointer interaction without stealing outside focus", async () => {
		renderApp(activeProps);
		openMobileControls();
		const outside = document.querySelector<HTMLElement>(".sonora-row-main");
		if (!outside) throw new Error("Outside control not found");
		outside.focus();

		fireEvent.pointerDown(outside);

		expect(screen.queryByRole("dialog", { name: "More playback controls" })).toBeNull();
		expect(document.activeElement).toBe(outside);
	});

	it("closes safely when the active item changes", () => {
		const view = renderApp(activeProps);
		openMobileControls();

		view.rerender(
			<SonoraApp
				{...activeProps}
				activeItemId={secondQueueItem.id}
				upNextItemId={null}
				playerState="idle"
				settings={DEFAULT_SETTINGS}
				recording={false}
				recordingRequesting={false}
				recordingAccessIssue={null}
				playbackError={null}
				spokenText=""
				spokenOffset={0}
				copy={copyFor("en", "en-US")}
				onBrowseNotes={vi.fn()}
				onBrowseVocabulary={vi.fn()}
				onCreateVocabularyTemplate={vi.fn()}
				onSelect={vi.fn()}
				onSelectChapter={vi.fn()}
				onPlayChapter={vi.fn()}
				onSetUpNext={vi.fn()}
				onReorder={vi.fn().mockResolvedValue(true)}
				onRemove={vi.fn()}
				removalUndo={null}
				onUndoRemove={vi.fn()}
				onDismissRemove={vi.fn()}
				onPlayPause={vi.fn()}
				onPrevious={vi.fn()}
				onNext={vi.fn()}
				onRestart={vi.fn()}
				onComplete={vi.fn()}
				onToggleRecording={vi.fn()}
				onDismissRecordingIssue={vi.fn()}
				onRateChange={vi.fn()}
				onOpenSource={vi.fn()}
				onToggleLoop={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("dialog", { name: "More playback controls" })).toBeNull();
	});

	it("removes document handlers without restoring focus when unmounted", () => {
		const view = renderApp(activeProps);
		const { trigger } = openMobileControls();

		view.unmount();
		fireEvent.keyDown(document, { key: "Escape" });

		expect(trigger.isConnected).toBe(false);
		expect(document.activeElement).not.toBe(trigger);
	});

	it("supports Arrow, Home, End, and bounded Tab navigation", async () => {
		renderApp(activeProps);
		const { popover } = openMobileControls();
		const restart = screen.getByRole("button", { name: "Restart" });
		await waitFor(() => expect(document.activeElement).toBe(restart));

		fireEvent.keyDown(restart, { key: "ArrowDown" });
		const record = within(popover).getByRole("button", { name: "Record response" });
		expect(document.activeElement).toBe(record);
		record.focus();
		fireEvent.keyDown(record, { key: "Home" });
		expect(document.activeElement).toBe(restart);
		fireEvent.keyDown(restart, { key: "End" });
		const complete = within(popover).getByRole("button", { name: "Mark listened" });
		expect(document.activeElement).toBe(complete);

		const tabStops = Array.from(
			popover.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)"),
		);
		const first = tabStops[0];
		const last = tabStops.at(-1);
		last?.focus();
		fireEvent.keyDown(last!, { key: "Tab" });
		expect(document.activeElement).toBe(first);
		first?.focus();
		fireEvent.keyDown(first!, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);
		expect(popover.contains(document.activeElement)).toBe(true);
	});
});

describe("SonoraApp recording recovery", () => {
	const activeProps = {
		queue: [firstQueueItem],
		activeItemId: firstQueueItem.id,
	};

	it("explains denied microphone access and retries from one alert", () => {
		const onToggleRecording = vi.fn();
		renderApp({ ...activeProps, recordingAccessIssue: "denied", onToggleRecording });

		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("Microphone access is blocked")).toBeTruthy();
		expect(within(alert).getByText(/device settings/)).toBeTruthy();
		fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
		expect(onToggleRecording).toHaveBeenCalledOnce();
	});

	it("prevents duplicate retries while microphone access is pending", () => {
		const onToggleRecording = vi.fn();
		renderApp({
			...activeProps,
			recordingAccessIssue: "transient",
			recordingRequesting: true,
			onToggleRecording,
		});

		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("aria-busy")).toBe("true");
		const retry = within(alert).getByRole("button", { name: "Requesting microphone access…" });
		expect((retry as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(retry);
		expect(onToggleRecording).not.toHaveBeenCalled();
	});

	it("distinguishes unsupported recording without offering a retry", () => {
		renderApp({ ...activeProps, recordingAccessIssue: "unsupported" });
		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("Recording is unavailable")).toBeTruthy();
		expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();
	});
});

describe("SonoraApp mobile library refinements", () => {
	it("opens one labelled filter dialog, focuses it, and restores focus on Escape", async () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });
		const trigger = screen.getByRole("button", { name: "Filter and sort" });

		fireEvent.click(trigger);
		const dialog = screen.getByRole("dialog", { name: "Filter and sort" });
		expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(dialog.getAttribute("aria-modal")).toBe("false");
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("combobox", { name: "Listening status" }),
			),
		);

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("keeps search available outside the filter dialog", () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });
		expect(
			screen.getByRole("searchbox", { name: "Search titles and chapter headings" }),
		).toBeTruthy();
		expect(screen.queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
	});

	it("uses natural Tab order when the mobile filter dialog is closed", () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });
		const sort = screen.getByRole("combobox", { name: "Sort library" });
		expect(fireEvent.keyDown(sort, { key: "Tab" })).toBe(true);
	});

	it("contains Tab focus only while the mobile filter dialog is open", () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });
		fireEvent.click(screen.getByRole("button", { name: "Filter and sort" }));
		const sort = screen.getByRole("combobox", { name: "Sort library" });
		expect(fireEvent.keyDown(sort, { key: "Tab" })).toBe(false);
		expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Listening status" }));
	});
});

describe("SonoraApp information hierarchy", () => {
	it("keeps playback controls in the authoritative player only", () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });
		expect(screen.getAllByRole("button", { name: "Play" })).toHaveLength(1);
		expect(document.querySelector(".sonora-featured")).toBeNull();
		expect(document.querySelector(".sonora-lyrics-heading")?.textContent).not.toContain(
			firstQueueItem.title,
		);
		expect(document.querySelector(".sonora-row-number")).toBeNull();
		expect(document.querySelector(".sonora-row-type")).toBeNull();
	});

	it("limits the reading surface to the current sentence and its immediate context", () => {
		renderApp({
			queue: [firstQueueItem],
			activeItemId: firstQueueItem.id,
			spokenText: "One. Two. Three. Four. Five.",
			spokenOffset: 12,
		});

		const lines = document.querySelectorAll(".sonora-lyrics-lines p");
		expect(lines).toHaveLength(3);
		expect(document.querySelectorAll(".sonora-lyrics-lines .is-current")).toHaveLength(1);
	});

	it("does not reserve or announce an empty player", () => {
		renderApp();
		expect(document.querySelector(".sonora-player")).toBeNull();
		expect(screen.queryByText("Add a note to start listening.")).toBeNull();
	});
});

describe("SonoraApp Up Next", () => {
	it("sets and clears one upcoming item without changing selection", () => {
		const onSetUpNext = vi.fn();
		const view = renderApp({
			queue: [firstQueueItem, secondQueueItem],
			activeItemId: firstQueueItem.id,
			onSetUpNext,
		});
		const setNext = screen.getByRole("button", { name: "Play Second next" });
		fireEvent.click(setNext);
		expect(onSetUpNext).toHaveBeenCalledWith("second");

		view.rerender(<SonoraApp {...view.props} upNextItemId="second" />);
		expect(document.querySelector(".sonora-player-up-next span")?.textContent).toBe("Up next");
		expect(document.querySelector(".sonora-player-up-next strong")?.textContent).toBe("Second");
		fireEvent.click(screen.getByRole("button", { name: "Clear Up Next" }));
		expect(onSetUpNext).toHaveBeenLastCalledWith(null);
	});

	it("does not offer the active item as Up Next", () => {
		renderApp({ queue: [firstQueueItem, secondQueueItem], activeItemId: firstQueueItem.id });
		expect(
			(screen.getByRole("button", { name: "Play First next" }) as HTMLButtonElement).disabled,
		).toBe(true);
	});
});

describe("SonoraApp library selection", () => {
	it("exposes only the active library item as current", () => {
		renderApp({
			queue: [firstQueueItem, secondQueueItem],
			activeItemId: secondQueueItem.id,
		});
		const itemButtons = document.querySelectorAll(".sonora-row-main");

		expect(itemButtons[0]?.getAttribute("aria-current")).toBeNull();
		expect(itemButtons[1]?.getAttribute("aria-current")).toBe("true");
	});

	it("combines title search and listening status without changing the kind filter", () => {
		const inProgress = {
			...secondQueueItem,
			chapterIndex: 1,
			chapters: [
				...secondQueueItem.chapters,
				{ heading: "Chapter two", level: 1, text: "Continue." },
			],
		};
		const drill = {
			...firstQueueItem,
			id: "drill",
			title: "Spanish",
			kind: "drill" as const,
			completed: true,
		};
		renderApp({ queue: [firstQueueItem, inProgress, drill], activeItemId: firstQueueItem.id });

		fireEvent.change(screen.getByRole("combobox", { name: "Listening status" }), {
			target: { value: "in-progress" },
		});
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(1);
		expect(document.querySelector(".sonora-row-title strong")?.textContent).toBe("Second");

		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search titles and chapter headings" }),
			{
				target: { value: "span" },
			},
		);
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(0);
	});

	it("presents content kinds as a labelled library filter with an All option", () => {
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });

		const filter = screen.getByRole("navigation", { name: "Library" });
		expect(within(filter).getByRole("button", { name: /All/ }).getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(within(filter).getByRole("button", { name: /Notes/ })).toBeTruthy();
		expect(within(filter).getByRole("button", { name: /Language drills/ })).toBeTruthy();
	});

	it("searches chapter headings and identifies the matching chapter in the result", () => {
		const chapterMatch = {
			...firstQueueItem,
			title: "Release notes",
			chapters: [
				firstQueueItem.chapters[0]!,
				{ heading: "Mobile playback", level: 2, text: "Keep controls reachable." },
			],
		};
		renderApp({ queue: [chapterMatch, secondQueueItem], activeItemId: chapterMatch.id });

		const search = screen.getByRole("searchbox", {
			name: "Search titles and chapter headings",
		});
		expect(search.getAttribute("placeholder")).toBe("Title or chapter heading");
		fireEvent.change(search, { target: { value: "playback" } });

		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(1);
		expect(document.querySelector(".sonora-row-title strong")?.textContent).toBe("Release notes");
		expect(document.querySelector(".sonora-row-title small")?.textContent).toBe(
			"Matching chapter: Mobile playback",
		);
	});

	it("opens the matching chapter without treating a title match as a chapter jump", () => {
		const onSelect = vi.fn();
		const onSelectChapter = vi.fn();
		const chapterMatch = {
			...firstQueueItem,
			title: "Release notes",
			chapters: [
				firstQueueItem.chapters[0]!,
				{ heading: "Mobile playback", level: 2, text: "Keep controls reachable." },
			],
		};
		renderApp({
			queue: [chapterMatch],
			activeItemId: chapterMatch.id,
			onSelect,
			onSelectChapter,
		});

		const search = screen.getByRole("searchbox", {
			name: "Search titles and chapter headings",
		});
		fireEvent.change(search, { target: { value: "playback" } });
		fireEvent.click(screen.getByRole("button", { name: /Open Release notes at Mobile playback/ }));
		expect(onSelectChapter).toHaveBeenCalledWith(chapterMatch.id, 1);
		expect(onSelect).not.toHaveBeenCalled();

		fireEvent.change(search, { target: { value: "release" } });
		fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-row-main")!);
		expect(onSelect).toHaveBeenCalledWith(chapterMatch.id);
		expect(onSelectChapter).toHaveBeenCalledOnce();
	});

	it("keeps an active item outside filters visible in a separate status region", () => {
		const activeNote = { ...firstQueueItem, title: "Playing note" };
		const drill = {
			...secondQueueItem,
			title: "Visible drill",
			kind: "drill" as const,
		};
		const onSelect = vi.fn();
		renderApp({ queue: [activeNote, drill], activeItemId: activeNote.id, onSelect });

		fireEvent.click(screen.getByRole("button", { name: /^Language drills/ }));

		const outside = screen.getByRole("status", { name: "Now playing outside current filters" });
		expect(outside.textContent).toBe("Outside current filtersShow in library");
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(1);
		expect(onSelect).not.toHaveBeenCalled();

		fireEvent.click(within(outside).getByRole("button", { name: "Show in library" }));
		expect(
			screen.queryByRole("status", { name: "Now playing outside current filters" }),
		).toBeNull();
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(2);
		expect(document.querySelector(".sonora-library-row.is-active")).not.toBeNull();
	});

	it.each(["search", "status", "combined"] as const)(
		"keeps displayed playback controls bound to the authoritative item under %s filtering",
		(mode) => {
			const onPlayPause = vi.fn();
			const onNext = vi.fn();
			const onComplete = vi.fn();
			const onOpenSource = vi.fn();
			renderApp({
				queue: [firstQueueItem, { ...secondQueueItem, completed: true }],
				activeItemId: firstQueueItem.id,
				onPlayPause,
				onNext,
				onComplete,
				onOpenSource,
			});

			if (mode === "search" || mode === "combined") {
				fireEvent.change(
					screen.getByRole("searchbox", { name: "Search titles and chapter headings" }),
					{
						target: { value: "Second" },
					},
				);
			}
			if (mode === "status" || mode === "combined") {
				fireEvent.change(screen.getByRole("combobox", { name: "Listening status" }), {
					target: { value: "completed" },
				});
			}

			expect(document.querySelector(".sonora-row-title strong")?.textContent).toBe("Second");
			expect(document.querySelector(".sonora-player-track small")?.textContent).toBe("First");
			fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-player-play")!);
			fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-player-next")!);
			fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-complete")!);
			fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-player-track")!);
			fireEvent.click(screen.getByRole("button", { name: "Open source note" }));

			expect(onPlayPause).toHaveBeenCalledWith(firstQueueItem.id);
			expect(onNext).toHaveBeenCalledWith(firstQueueItem.id);
			expect(onComplete).toHaveBeenCalledWith(firstQueueItem.id);
			expect(onOpenSource).toHaveBeenCalledWith(firstQueueItem.id);
		},
	);

	it("sorts by progress and offers one recovery action for an empty result", () => {
		const onBrowseNotes = vi.fn();
		const inProgress = {
			...secondQueueItem,
			addedAt: 2,
			chapterIndex: 1,
			chapters: [
				...secondQueueItem.chapters,
				{ heading: "Chapter two", level: 1, text: "Continue." },
			],
		};
		renderApp({
			queue: [firstQueueItem, inProgress],
			activeItemId: firstQueueItem.id,
			onBrowseNotes,
		});

		fireEvent.change(screen.getByRole("combobox", { name: "Sort library" }), {
			target: { value: "progress" },
		});
		const rows = document.querySelectorAll(".sonora-row-title strong");
		expect(rows[0]?.textContent).toBe("Second");

		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search titles and chapter headings" }),
			{
				target: { value: "missing" },
			},
		);
		expect(screen.getByText("No items match the current filters.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Add a listening note" })).toBeNull();
		expect(onBrowseNotes).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Show all" }));
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(2);
	});

	it("keeps the visible item, player, and actions aligned after removing the active filtered item", () => {
		const note = { ...firstQueueItem, id: "note", title: "Note" };
		const drillA = { ...firstQueueItem, id: "drill-a", title: "Drill A", kind: "drill" as const };
		const drillB = { ...secondQueueItem, id: "drill-b", title: "Drill B", kind: "drill" as const };
		const onRemove = vi.fn();
		const onPlayPause = vi.fn();
		const view = renderApp({
			queue: [note, drillA, drillB],
			activeItemId: drillA.id,
			onRemove,
			onPlayPause,
		});
		fireEvent.click(screen.getByRole("button", { name: /^Language drills/ }));
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search titles and chapter headings" }),
			{
				target: { value: "Drill" },
			},
		);
		fireEvent.change(screen.getByRole("combobox", { name: "Listening status" }), {
			target: { value: "unplayed" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Remove Drill A" }), { detail: 1 });
		expect(onRemove).toHaveBeenCalledWith(drillA.id, false, drillB.id);

		const queue = [note, drillB];
		const activeItemId = activeItemAfterRemoval(queue, 1, drillB.id);
		view.rerender(<SonoraApp {...view.props} queue={queue} activeItemId={activeItemId} />);
		expect(document.querySelectorAll(".sonora-library-row")).toHaveLength(1);
		expect(document.querySelector(".sonora-row-title strong")?.textContent).toBe("Drill B");
		expect(document.querySelector(".sonora-featured")).toBeNull();
		expect(document.querySelector(".sonora-player-track small")?.textContent).toBe("Drill B");
		fireEvent.click(document.querySelector<HTMLButtonElement>(".sonora-player-play")!);
		expect(onPlayPause).toHaveBeenCalledWith(drillB.id);
	});

	it("rejects a missing preferred active ID and uses the adjacent queue item", () => {
		expect(activeItemAfterRemoval([secondQueueItem], 0, "missing")).toBe(secondQueueItem.id);
		expect(activeItemAfterRemoval([], 0, "missing")).toBeNull();
	});
});

describe("SonoraApp removal undo", () => {
	it("moves a filtered-visible item by ID and announces the durable result", async () => {
		const onReorder = vi.fn().mockResolvedValue(true);
		renderApp({
			queue: [firstQueueItem, secondQueueItem],
			activeItemId: firstQueueItem.id,
			onReorder,
		});
		const trigger = screen.getByRole("button", { name: "More actions for First" });
		fireEvent.click(trigger);
		fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Move down" }));

		await waitFor(() =>
			expect(onReorder).toHaveBeenCalledWith(firstQueueItem.id, secondQueueItem.id, "after"),
		);
		await waitFor(() => expect(screen.getByText("Moved First down.")).toBeTruthy());
	});

	it("announces a persistence rollback instead of a successful move", async () => {
		renderApp({
			queue: [firstQueueItem, secondQueueItem],
			activeItemId: firstQueueItem.id,
			onReorder: vi.fn().mockResolvedValue(false),
		});
		fireEvent.click(screen.getByRole("button", { name: "More actions for First" }));
		fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Move down" }));

		await waitFor(() =>
			expect(screen.getByText("Could not save the new queue order.")).toBeTruthy(),
		);
		await waitFor(() =>
			expect(document.activeElement).toBe(document.querySelector(".sonora-row-main")),
		);
	});

	it("opens the row overflow menu, restores focus on Escape, and preserves keyboard removal", async () => {
		const onRemove = vi.fn();
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id, onRemove });
		const trigger = screen.getByRole("button", { name: "More actions for First" });

		fireEvent.click(trigger);
		const menu = screen.getByRole("menu");
		const remove = within(menu).getByRole("menuitem", { name: "Remove First" });
		await waitFor(() => expect(document.activeElement).toBe(remove));

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("menu")).toBeNull();

		fireEvent.click(trigger);
		const reopenedRemove = within(screen.getByRole("menu")).getByRole("menuitem", {
			name: "Remove First",
		});
		fireEvent.click(reopenedRemove, { detail: 0 });
		expect(onRemove).toHaveBeenCalledWith(firstQueueItem.id, true, null);
	});

	it("moves focus to undo only for a keyboard-initiated removal", async () => {
		const onUndoRemove = vi.fn();
		renderApp({
			removalUndo: {
				id: firstQueueItem.id,
				title: firstQueueItem.title,
				focusUndo: true,
				returnFocusItemId: null,
			},
			onUndoRemove,
		});

		expect(screen.getByRole("status").textContent).toContain("Removed “First” from your library.");
		const undo = screen.getByRole("button", { name: "Undo" });
		await waitFor(() => expect(document.activeElement).toBe(undo));
		fireEvent.click(undo);

		expect(onUndoRemove).toHaveBeenCalledWith(firstQueueItem.id);
	});

	it("does not steal focus after a pointer-initiated removal", () => {
		renderApp({
			removalUndo: {
				id: firstQueueItem.id,
				title: firstQueueItem.title,
				focusUndo: false,
				returnFocusItemId: null,
			},
		});

		expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Undo" }));
	});

	it("reports keyboard versus pointer activation when removing", () => {
		const onRemove = vi.fn();
		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id, onRemove });
		const remove = screen.getByRole("button", { name: "Remove First" });

		fireEvent.click(remove, { detail: 0 });
		fireEvent.click(remove, { detail: 1 });

		expect(onRemove).toHaveBeenNthCalledWith(1, firstQueueItem.id, true, null);
		expect(onRemove).toHaveBeenNthCalledWith(2, firstQueueItem.id, false, null);
	});

	it("dismisses the undo and restores focus to the adjacent item", async () => {
		const onDismissRemove = vi.fn().mockResolvedValue(undefined);
		renderApp({
			queue: [secondQueueItem],
			activeItemId: secondQueueItem.id,
			removalUndo: {
				id: firstQueueItem.id,
				title: firstQueueItem.title,
				focusUndo: true,
				returnFocusItemId: secondQueueItem.id,
			},
			onDismissRemove,
		});

		fireEvent.click(screen.getByRole("button", { name: "Dismiss undo" }));

		await waitFor(() =>
			expect(document.activeElement).toBe(document.querySelector(".sonora-row-main")),
		);
		expect(onDismissRemove).toHaveBeenCalledWith(firstQueueItem.id);
	});

	it("restores focus to the adjacent item when the undo expires", async () => {
		const undo = {
			id: firstQueueItem.id,
			title: firstQueueItem.title,
			focusUndo: true,
			returnFocusItemId: secondQueueItem.id,
		};
		const view = renderApp({
			queue: [secondQueueItem],
			activeItemId: secondQueueItem.id,
			removalUndo: undo,
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" })),
		);

		view.rerender(
			<SonoraApp
				{...{
					queue: [secondQueueItem],
					activeItemId: secondQueueItem.id,
					upNextItemId: null,
					playerState: "idle" as const,
					settings: DEFAULT_SETTINGS,
					recording: false,
					recordingRequesting: false,
					recordingAccessIssue: null,
					playbackError: null,
					spokenText: "",
					spokenOffset: 0,
					copy: copyFor("en", "en-US"),
					removalUndo: null,
					onBrowseNotes: vi.fn(),
					onBrowseVocabulary: vi.fn(),
					onCreateVocabularyTemplate: vi.fn(),
					onSelect: vi.fn(),
					onSelectChapter: vi.fn(),
					onPlayChapter: vi.fn(),
					onSetUpNext: vi.fn(),
					onReorder: vi.fn().mockResolvedValue(true),
					onRemove: vi.fn(),
					onUndoRemove: vi.fn(),
					onDismissRemove: vi.fn(),
					onPlayPause: vi.fn(),
					onPrevious: vi.fn(),
					onNext: vi.fn(),
					onRestart: vi.fn(),
					onComplete: vi.fn(),
					onToggleRecording: vi.fn(),
					onDismissRecordingIssue: vi.fn(),
					onRateChange: vi.fn(),
					onOpenSource: vi.fn(),
					onToggleLoop: vi.fn(),
				}}
			/>,
		);

		await waitFor(() =>
			expect(document.activeElement).toBe(document.querySelector(".sonora-row-main")),
		);
	});

	it("localizes the undo region", () => {
		renderApp({
			copy: copyFor("ja", "ja-JP"),
			removalUndo: {
				id: firstQueueItem.id,
				title: firstQueueItem.title,
				focusUndo: false,
				returnFocusItemId: null,
			},
		});

		expect(screen.getByRole("region", { name: "元に戻す" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "元に戻す" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "元に戻す通知を閉じる" })).toBeTruthy();
	});
});

describe("SonoraApp playback progress", () => {
	it("announces the current chapter and total as a progressbar", () => {
		renderApp({
			queue: [
				{
					...firstQueueItem,
					chapters: [
						...firstQueueItem.chapters,
						{ heading: "Chapter two", level: 1, text: "Continue." },
						{ heading: "Chapter three", level: 1, text: "Finish." },
					],
					chapterIndex: 1,
				},
			],
			activeItemId: firstQueueItem.id,
		});

		const progress = screen.getByRole("progressbar", { name: "Chapter 2 of 3" });
		expect(progress.getAttribute("aria-valuemin")).toBe("1");
		expect(progress.getAttribute("aria-valuemax")).toBe("3");
		expect(progress.getAttribute("aria-valuenow")).toBe("2");
	});

	it("localizes navigation and loop accessible names", () => {
		renderApp({
			queue: [{ ...firstQueueItem, kind: "drill", loop: false }],
			activeItemId: firstQueueItem.id,
			copy: copyFor("ja", "ja-JP"),
		});

		expect(screen.getByRole("complementary", { name: "Sonoraナビゲーション" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "ループ" })).toBeTruthy();
	});
});

describe("LyricsCard motion preferences", () => {
	it("scrolls immediately when reduced motion is requested", () => {
		vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true } as MediaQueryList));

		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });

		expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "auto" }),
		);
	});

	it("uses smooth scrolling when matchMedia is unavailable", () => {
		vi.stubGlobal("matchMedia", undefined);

		renderApp({ queue: [firstQueueItem], activeItemId: firstQueueItem.id });

		expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith(
			expect.objectContaining({ behavior: "smooth" }),
		);
	});
});
