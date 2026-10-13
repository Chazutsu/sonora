import { describe, expect, it, vi } from "vitest";
import { languageForText, nextUnfinishedQueueItem, selectVoice, SpeechPlayer } from "../src/player";
import type { QueueItem } from "../src/types";

type TestUtterance = SpeechSynthesisUtterance & {
	emit(type: string, event?: Event): void;
};

function createTestUtterance(): TestUtterance {
	const target = new EventTarget();
	return Object.assign(target, {
		emit(type: string, event = new Event(type)) {
			target.dispatchEvent(event);
		},
	}) as unknown as TestUtterance;
}

function playerFixture() {
	const utterances: TestUtterance[] = [];
	const synthesis = {
		cancel: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		speak: vi.fn(),
		getVoices: vi.fn(() => []),
	} as unknown as SpeechSynthesis;
	const states: string[] = [];
	const ended = vi.fn();
	const player = new SpeechPlayer(
		synthesis,
		() => {
			const utterance = createTestUtterance();
			utterances.push(utterance);
			return utterance;
		},
		(state) => states.push(state),
		ended,
	);
	return { ended, player, states, synthesis, utterances };
}

function queueItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
	return {
		id,
		path: `${id}.md`,
		title: id,
		chapters: [{ heading: id, level: 1, text: id }],
		chapterIndex: 0,
		completed: false,
		addedAt: 1,
		kind: "note",
		...overrides,
	};
}

describe("SpeechPlayer", () => {
	it("speaks a chapter and reports completion", () => {
		const fixture = playerFixture();
		fixture.player.play("First sentence. Second sentence.", {
			rate: 1,
			pitch: 1,
			lang: "en-US",
			voiceName: "",
		});
		expect(fixture.synthesis.speak).toHaveBeenCalledTimes(1);
		fixture.utterances[0]?.emit("end");
		expect(fixture.synthesis.speak).toHaveBeenCalledTimes(2);
		fixture.utterances[1]?.emit("end");
		expect(fixture.ended).toHaveBeenCalledOnce();
		expect(fixture.states.at(-1)).toBe("idle");
	});

	it("supports pause and resume", () => {
		const fixture = playerFixture();
		fixture.player.play("Listen", { rate: 1, pitch: 1, lang: "en-US", voiceName: "" });
		fixture.player.pause();
		fixture.player.resume();
		expect(fixture.synthesis.pause).toHaveBeenCalledOnce();
		expect(fixture.synthesis.resume).toHaveBeenCalledOnce();
		expect(fixture.player.currentState()).toBe("playing");
	});

	it("does not create a false paused or playing state while idle", () => {
		const fixture = playerFixture();
		expect(fixture.player.pause()).toBe(false);
		expect(fixture.player.resume()).toBe(false);
		expect(fixture.synthesis.pause).not.toHaveBeenCalled();
		expect(fixture.synthesis.resume).not.toHaveBeenCalled();
		expect(fixture.player.currentState()).toBe("idle");
	});

	it("ignores late completion after stop", () => {
		const fixture = playerFixture();
		fixture.player.play("Listen", { rate: 1, pitch: 1, lang: "en-US", voiceName: "" });
		const staleUtterance = fixture.utterances[0];
		fixture.player.stop();
		staleUtterance?.emit("end");
		expect(fixture.ended).not.toHaveBeenCalled();
		expect(fixture.player.currentState()).toBe("idle");
	});

	it("ignores a late end event after the same utterance has errored", () => {
		const fixture = playerFixture();
		fixture.player.play("First sentence. Second sentence.", {
			rate: 1,
			pitch: 1,
			lang: "en-US",
			voiceName: "",
		});
		const utterance = fixture.utterances[0];
		utterance?.emit("error", Object.assign(new Event("error"), { error: "synthesis-failed" }));
		utterance?.emit("end");
		expect(fixture.synthesis.speak).toHaveBeenCalledTimes(1);
		expect(fixture.ended).not.toHaveBeenCalled();
		expect(fixture.player.currentState()).toBe("error");
	});

	it("reports the start of every chunk even without boundary events", () => {
		const progress = vi.fn();
		const fixture = playerFixture();
		const player = new SpeechPlayer(
			fixture.synthesis,
			() => {
				const utterance = createTestUtterance();
				fixture.utterances.push(utterance);
				return utterance;
			},
			vi.fn(),
			fixture.ended,
			progress,
		);
		player.play("First sentence. Second sentence.", {
			rate: 1,
			pitch: 1,
			lang: "en-US",
			voiceName: "",
		});
		fixture.utterances[0]?.emit("end");
		expect(progress).toHaveBeenCalledWith(0);
		expect(progress.mock.calls.some(([offset]) => offset > 0)).toBe(true);
	});
});

describe("languageForText", () => {
	it("switches Japanese answer segments to a Japanese voice", () => {
		expect(languageForText("回復力がある。", "en-US")).toBe("ja-JP");
		expect(languageForText("resilient", "en-US")).toBe("en-US");
	});
});

describe("selectVoice", () => {
	it("ignores a preferred voice that does not match the spoken language", () => {
		const english = { name: "English", lang: "en-US", localService: true } as SpeechSynthesisVoice;
		const japanese = {
			name: "Japanese",
			lang: "ja-JP",
			localService: true,
		} as SpeechSynthesisVoice;
		expect(selectVoice([english, japanese], "ja-JP", "English")).toBe(japanese);
	});
});

describe("nextUnfinishedQueueItem", () => {
	it("selects the next playable unfinished note in queue order", () => {
		const queue = [
			queueItem("current"),
			queueItem("completed", { completed: true }),
			queueItem("drill", { kind: "drill" }),
			queueItem("unavailable", { unavailable: true }),
			queueItem("next"),
		];
		expect(nextUnfinishedQueueItem(queue, "current")?.id).toBe("next");
	});

	it("does not wrap to an unfinished item before the current item", () => {
		const queue = [
			queueItem("earlier"),
			queueItem("current"),
			queueItem("later", { completed: true }),
		];
		expect(nextUnfinishedQueueItem(queue, "current")).toBeNull();
	});

	it("does not leave a drill automatically", () => {
		const queue = [queueItem("drill", { kind: "drill" }), queueItem("next")];
		expect(nextUnfinishedQueueItem(queue, "drill")).toBeNull();
	});

	it("ignores unreadable and empty queue items", () => {
		const queue = [
			queueItem("current"),
			queueItem("failed", { loadError: true }),
			queueItem("empty", { chapters: [] }),
		];
		expect(nextUnfinishedQueueItem(queue, "current")).toBeNull();
	});
});
