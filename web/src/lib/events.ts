import type { Level } from "../api";

export const LEVELS: ReadonlyArray<Level> = [
  "info",
  "success",
  "warning",
  "error",
  "critical",
];

export const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
};

export const relative = (value: string) => {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return Math.abs(hours) < 24
    ? formatter.format(hours, "hour")
    : formatter.format(Math.round(hours / 24), "day");
};

export const dayGroup = (value: string) => {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return date.toDateString() === yesterday.toDateString()
    ? "Yesterday"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
};

export const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ["javascript:", "data:", "file:"].includes(
      url.protocol.toLowerCase(),
    )
      ? undefined
      : url.href;
  } catch {
    return undefined;
  }
};

export const display = (value: unknown) =>
  typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value);

export const eventFrames = (data: Record<string, unknown>) => {
  if (Array.isArray(data.stacktrace)) return data.stacktrace;
  const exception = data.exception;
  if (!exception || typeof exception !== "object" || Array.isArray(exception))
    return undefined;
  const frames = (exception as Record<string, unknown>).frames;
  return Array.isArray(frames) ? frames : undefined;
};

export const stackFrame = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const raw = display(value);
    return {
      raw,
      file: "",
      func: "",
      line: "",
      column: "",
      internal:
        raw.includes("node_modules") ||
        raw.includes("node:") ||
        raw.includes("internal/"),
    };
  }
  const frame = value as Record<string, unknown>;
  const file = display(frame.file ?? frame.filename);
  return {
    raw: "",
    file,
    func: display(frame.func ?? frame.function ?? frame.module),
    line: display(frame.line ?? frame.lineno),
    column: display(frame.column ?? frame.colno),
    internal:
      frame.in_app === false ||
      file.includes("node_modules") ||
      file.startsWith("node:") ||
      file.includes("internal/"),
  };
};

export const formatStackTrace = (
  errorType: string | undefined,
  message: string | undefined,
  frames: ReadonlyArray<unknown>,
) => [
  [errorType, message].filter(Boolean).join(": "),
  ...frames.slice().reverse().map((value) => {
    const frame = stackFrame(value);
    if (!frame.file && !frame.func) return frame.raw;
    const location = `${frame.file}${frame.line ? `:${frame.line}` : ""}${frame.column ? `:${frame.column}` : ""}`;
    return `at ${frame.func}${frame.func && location ? " " : ""}${location ? `(${location})` : ""}`;
  }),
].filter(Boolean).join("\n");
