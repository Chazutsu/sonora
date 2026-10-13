import { describe, expect, it } from "vitest";
import { classifyRecordingAccessError } from "../src/recording-access";

describe("recording access errors", () => {
	it.each(["NotAllowedError", "PermissionDeniedError", "SecurityError"])(
		"classifies %s as denied",
		(name) => expect(classifyRecordingAccessError({ name })).toBe("denied"),
	);

	it.each(["NotFoundError", "DevicesNotFoundError", "NotSupportedError"])(
		"classifies %s as unsupported",
		(name) => expect(classifyRecordingAccessError({ name })).toBe("unsupported"),
	);

	it("handles missing DOMException APIs and unknown errors", () => {
		expect(classifyRecordingAccessError(new Error("device busy"))).toBe("transient");
		expect(classifyRecordingAccessError(null)).toBe("transient");
	});
});
