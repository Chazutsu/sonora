export type RecordingAccessIssue = "denied" | "unsupported" | "transient";

const DENIED_ERROR_NAMES = new Set(["NotAllowedError", "PermissionDeniedError", "SecurityError"]);
const UNSUPPORTED_ERROR_NAMES = new Set([
	"NotFoundError",
	"DevicesNotFoundError",
	"NotSupportedError",
]);

function errorName(error: unknown): string {
	if (typeof error !== "object" || error === null || !("name" in error)) return "";
	return typeof error.name === "string" ? error.name : "";
}

export function classifyRecordingAccessError(error: unknown): RecordingAccessIssue {
	const name = errorName(error);
	if (DENIED_ERROR_NAMES.has(name)) return "denied";
	if (UNSUPPORTED_ERROR_NAMES.has(name)) return "unsupported";
	return "transient";
}
