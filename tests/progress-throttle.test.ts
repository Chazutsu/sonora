import { describe, expect, it } from "vitest";
import {
	initialBoundaryThrottleState,
	reduceBoundaryProgress,
	speechProgressLines,
	visibleSpeechSegment,
} from "../src/progress-throttle";

describe("reduceBoundaryProgress", () => {
	it("emits the leading update and throttles rapid boundary events", () => {
		const first = reduceBoundaryProgress(
			initialBoundaryThrottleState(),
			{ character: 2, at: 100 },
			80,
		);
		const rapid = reduceBoundaryProgress(first.state, { character: 5, at: 130 }, 80);
		const due = reduceBoundaryProgress(rapid.state, { character: 8, at: 180 }, 80);

		expect(first.emittedCharacter).toBe(2);
		expect(rapid.emittedCharacter).toBeNull();
		expect(rapid.state.pendingCharacter).toBe(5);
		expect(due.emittedCharacter).toBe(8);
	});

	it("allows a caller to force a chapter or terminal position", () => {
		const first = reduceBoundaryProgress(
			initialBoundaryThrottleState(),
			{ character: 10, at: 100 },
			80,
		);
		const forced = reduceBoundaryProgress(first.state, { character: 20, at: 110, force: true }, 80);
		expect(forced.emittedCharacter).toBe(20);
		expect(forced.state.pendingCharacter).toBeNull();
	});

	it("is deterministic and does not mutate its input", () => {
		const state = Object.freeze({
			lastEmittedAt: 100,
			lastEmittedCharacter: 3,
			pendingCharacter: null,
		});
		const result = reduceBoundaryProgress(state, { character: 4, at: 120 }, 80);
		expect(state.pendingCharacter).toBeNull();
		expect(result.state).not.toBe(state);
	});
});

describe("visibleSpeechSegment", () => {
	it("changes only when the highlighted sentence changes", () => {
		const text = "First sentence. Second sentence. Third sentence.";
		const lines = speechProgressLines(text);
		expect(visibleSpeechSegment(text, 0)).toBe(0);
		expect(visibleSpeechSegment(text, 5)).toBe(0);
		expect(visibleSpeechSegment(text, lines[0]?.length ?? 0)).toBe(1);
		expect(visibleSpeechSegment(text, text.length)).toBe(2);
	});

	it("handles Japanese punctuation and empty text", () => {
		expect(visibleSpeechSegment("最初。次。", 3)).toBe(1);
		expect(visibleSpeechSegment("", 0)).toBe(-1);
	});
});
