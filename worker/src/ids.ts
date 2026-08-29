export const nowIso = (): string => new Date().toISOString()

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))
