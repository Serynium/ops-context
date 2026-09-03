import { describe, expect, it, vi } from "vitest";
import { hrefFor, matchRoute } from "./router";

vi.mock("@stylexjs/stylex", () => ({
  create: <T>(styles: T) => styles,
  keyframes: () => "animation",
}));

describe("router", () => {
  it("matches and safely encodes dynamic paths", () => {
    expect(matchRoute("/events/event%201")?.params).toEqual({
      eventId: "event 1",
    });
    expect(matchRoute("/groups/project/fingerprint")?.params).toEqual({
      projectId: "project",
      fingerprint: "fingerprint",
    });
    expect(hrefFor("/events/$eventId", { eventId: "event/1" })).toBe(
      "/events/event%2F1",
    );
    expect(matchRoute("/missing")).toBeNull();
  });
});
