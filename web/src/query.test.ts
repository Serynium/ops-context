import { describe, expect, it, vi } from "vitest";
import { matchesKey, QueryClient, withRetry } from "./query";

describe("query helpers", () => {
  it("matches invalidation prefixes and retries once", async () => {
    expect(matchesKey(["event", "1"], ["event"])).toBe(true);
    expect(matchesKey(["events"], ["event"])).toBe(false);
    const operation = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue("ok");
    await expect(withRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("caches and invalidates matching queries", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 15_000 } },
    });
    const queryFn = vi.fn().mockResolvedValueOnce("first").mockResolvedValue("second");
    const entry = client.entry<string>(["event", "1"]);
    entry.queryFn = queryFn;
    await client.fetch(entry);
    await client.fetch(entry);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await client.invalidateQueries({ queryKey: ["event"] });
    expect(entry.data).toBe("second");
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
