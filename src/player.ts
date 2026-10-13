import { splitForSpeech } from "./content";
import {
	initialBoundaryThrottleState,
	reduceBoundaryProgress,
	type BoundaryThrottleState,
} from "./progress-throttle";
import type { QueueItem } from "./types";

export type PlayerState = "idle" | "playing" | "paused" | "error";

export type SpeechOptions = {
	rate: number;
	pitch: number;
	lang: string;
	voiceName: string;
};

/**
 * Finds the next playable listening note without wrapping around the queue.
 * Drills require an explicit choice because their prompt/answer flow must not
 * be entered as a side effect of finishing another note.
 */
export function nextUnfinishedQueueItem(
	queue: readonly QueueItem[],
	currentItemId: string,
): QueueItem | null {
	const currentIndex = queue.findIndex((item) => item.id === currentItemId);
	if (currentIndex < 0) return null;
	if (queue[currentIndex]?.kind === "drill") return null;
	return (
		queue
			.slice(currentIndex + 1)
			.find(
				(item) =>
					!item.completed &&
					item.kind !== "drill" &&
					!item.unavailable &&
					!item.loadError &&
					item.chapters.length > 0,
			) ?? null
	);
}

export class SpeechPlayer {
	private chunks: string[] = [];
	private chunkOffsets: number[] = [];
	private chunkIndex = 0;
	private generation = 0;
	private state: PlayerState = "idle";
	private progressThrottle: BoundaryThrottleState = initialBoundaryThrottleState();

	constructor(
		private readonly synthesis: SpeechSynthesis,
		private readonly utteranceFactory: () => SpeechSynthesisUtterance,
		private readonly onStateChange: (state: PlayerState) => void,
		private readonly onEnded: () => void,
		private readonly onProgress: (character: number) => void = () => {},
		private readonly onError: (error: SpeechSynthesisErrorCode | "unavailable") => void = () => {},
		private readonly now: () => number = Date.now,
		private readonly boundaryIntervalMs = 80,
	) {}

	play(text: string, options: SpeechOptions): void {
		this.stop(false);
		this.chunks = splitForSpeech(text);
		if (!this.chunks.length) {
			this.setState("error");
			this.onError("unavailable");
			return;
		}
		let offset = 0;
		this.chunkOffsets = this.chunks.map((chunk) => {
			const current = offset;
			offset += chunk.length;
			return current;
		});
		this.chunkIndex = 0;
		this.generation += 1;
		this.progressThrottle = initialBoundaryThrottleState();
		this.reportProgress(0, true);
		this.speakCurrent(options, this.generation);
	}

	resume(): boolean {
		if (this.state !== "paused" || !this.chunks.length) return false;
		this.synthesis.resume();
		this.setState("playing");
		return true;
	}

	pause(): boolean {
		if (this.state !== "playing") return false;
		this.synthesis.pause();
		this.setState("paused");
		return true;
	}

	stop(notify = true): void {
		this.generation += 1;
		this.synthesis.cancel();
		this.chunks = [];
		this.chunkOffsets = [];
		this.chunkIndex = 0;
		this.progressThrottle = initialBoundaryThrottleState();
		if (notify) this.setState("idle");
	}

	currentState(): PlayerState {
		return this.state;
	}

	private speakCurrent(options: SpeechOptions, generation: number): void {
		const text = this.chunks[this.chunkIndex];
		if (!text) {
			this.setState("idle");
			this.onEnded();
			return;
		}
		const utterance = this.utteranceFactory();
		utterance.text = text;
		utterance.rate = options.rate;
		utterance.pitch = options.pitch;
		utterance.lang = languageForText(text, options.lang);
		utterance.voice = selectVoice(this.synthesis.getVoices(), utterance.lang, options.voiceName);
		this.reportProgress(this.chunkOffsets[this.chunkIndex] ?? 0, true);
		utterance.addEventListener("boundary", (event) => {
			if (generation !== this.generation) return;
			this.reportProgress((this.chunkOffsets[this.chunkIndex] ?? 0) + event.charIndex);
		});
		utterance.addEventListener("end", () => {
			if (generation !== this.generation) return;
			this.chunkIndex += 1;
			this.speakCurrent(options, generation);
		});
		utterance.addEventListener("error", (event) => {
			if (generation !== this.generation) return;
			// Some Web Speech implementations dispatch `end` after `error`. Make
			// every callback belonging to this utterance stale before notifying UI.
			this.generation += 1;
			this.setState("error");
			this.onError(event.error);
		});
		this.synthesis.speak(utterance);
		this.setState("playing");
	}

	private setState(state: PlayerState): void {
		this.state = state;
		this.onStateChange(state);
	}

	private reportProgress(character: number, force = false): void {
		const result = reduceBoundaryProgress(
			this.progressThrottle,
			{ character, at: this.now(), force },
			this.boundaryIntervalMs,
		);
		this.progressThrottle = result.state;
		if (result.emittedCharacter !== null) this.onProgress(result.emittedCharacter);
	}
}

export function languageForText(text: string, fallback: string): string {
	return /[ぁ-んァ-ヶ一-龯]/u.test(text) ? "ja-JP" : fallback;
}

export function selectVoice(
	voices: SpeechSynthesisVoice[],
	language: string,
	preferredName: string,
): SpeechSynthesisVoice | null {
	const base = language.toLowerCase().split("-")[0] ?? language.toLowerCase();
	const preferred = voices.find(
		(voice) => voice.name === preferredName && voice.lang.toLowerCase().startsWith(base),
	);
	if (preferred) return preferred;
	const quality = (voice: SpeechSynthesisVoice) =>
		(/premium|enhanced|siri|kyoko|otoya|samantha|daniel/iu.test(voice.name) ? 4 : 0) +
		(voice.localService ? 2 : 0) +
		(voice.lang.toLowerCase() === language.toLowerCase() ? 1 : 0);
	return (
		voices
			.filter((voice) => voice.lang.toLowerCase().startsWith(base))
			.toSorted((left, right) => quality(right) - quality(left))[0] ?? null
	);
}
