import { LEVELS, type Level } from "./types.js"

const rank = new Map<Level, number>(LEVELS.map((level, index) => [level, index]))

export const isLevel = (value: unknown): value is Level =>
  typeof value === "string" && rank.has(value as Level)

export const atLeast = (actual: Level, minimum: Level): boolean =>
  (rank.get(actual) ?? 0) >= (rank.get(minimum) ?? 0)
