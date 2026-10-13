export interface BoundaryThrottleState {
	readonly lastEmittedAt: number | null;
	readonly lastEmittedCharacter: number | null;
	readonly pendingCharacter: number | null;
}

export interface BoundaryProgressInput {
	readonly character: number;
	readonly at: number;
	readonly force?: boolean;
}

export interface BoundaryProgressResult {
	readonly state: BoundaryThrottleState;
	readonly emittedCharacter: number | null;
}

export function speechProgressLines(text: string): string[] {
	return text.match(/[^。！？.!?]+[。！？.!?]+\s*|[^。！？.!?]+$/gu) ?? [text];
}

export function visibleSpeechSegment(text: string, offset: number): number {
	const lines = speechProgressLines(text);
	if (!lines.length || (lines.length === 1 && lines[0] === "")) return -1;
	let cursor = 0;
	const index = lines.findIndex((line) => {
		cursor += line.length;
		return offset < cursor;
	});
	return index === -1 ? lines.length - 1 : index;
}

export function initialBoundaryThrottleState(): BoundaryThrottleState {
	return {
		lastEmittedAt: null,
		lastEmittedCharacter: null,
		pendingCharacter: null,
	};
}

/**
 * Pure reducer for high-frequency Web Speech boundary events. Callers own the
 * clock and effects, which makes throttling deterministic in tests and avoids
 * a timer surviving a stopped utterance.
 */
export function reduceBoundaryProgress(
	state: BoundaryThrottleState,
	input: BoundaryProgressInput,
	intervalMs = 80,
): BoundaryProgressResult {
	const character = Math.max(0, Math.floor(input.character));
	const due =
		state.lastEmittedAt === null || input.at - state.lastEmittedAt >= Math.max(0, intervalMs);
	const changed = character !== state.lastEmittedCharacter;

	if (changed && (input.force === true || due)) {
		return {
			state: {
				lastEmittedAt: input.at,
				lastEmittedCharacter: character,
				pendingCharacter: null,
			},
			emittedCharacter: character,
		};
	}

	return {
		state: {
			...state,
			pendingCharacter: changed ? character : state.pendingCharacter,
		},
		emittedCharacter: null,
	};
}
