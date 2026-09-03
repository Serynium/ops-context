import { describe, expect, it } from "vitest";
import { eventFrames, formatStackTrace, stackFrame } from "../lib/events";

describe("eventFrames", () => {
	it("reads Sentry frames from the exception", () => {
		const frames = [{ file: "app/route.ts", func: "POST", line: 11 }];
		expect(eventFrames({ exception: { type: "Error", frames } })).toBe(frames);
	});

	it("keeps the generic top-level stacktrace format", () => {
		const frames = [{ filename: "app.py", function: "run", lineno: 4 }];
		expect(eventFrames({ stacktrace: frames })).toBe(frames);
	});

	it("formats a compact, newest-first trace and identifies internals", () => {
		const frames = [
			{ file: "node:internal/process", func: "run", line: 2, in_app: false },
			{ file: "app/route.ts", func: "POST", line: 11, in_app: true },
		];
		expect(formatStackTrace("Error", "failed", frames)).toBe(
			"Error: failed\nat POST (app/route.ts:11)\nat run (node:internal/process:2)",
		);
		expect(stackFrame(frames[0]).internal).toBe(true);
	});
});
