import { describe, expect, it, vi } from "vitest";
import { openInNewTab } from "./open-tab";

describe("openInNewTab", () => {
  it("always asks for a new tab", () => {
    const open = vi.fn(() => ({ opener: {} }) as unknown as Window);
    expect(openInNewTab("https://open.spotify.com", open)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://open.spotify.com", "_blank");
  });

  it("reports a blocked tab instead of opening in the same tab", () => {
    const open = vi.fn(() => null);
    expect(openInNewTab("https://open.spotify.com", open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
