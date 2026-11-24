import { describe, expect, it, vi } from "vitest";
import { extractOpenAction, openInNewTab } from "./open-tab";

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

describe("extractOpenAction", () => {
  it("reads a page the AI asked HAI to open", () => {
    expect(extractOpenAction("[[open:https://www.youtube.com/results?search_query=khat]]")).toEqual({
      url: "https://www.youtube.com/results?search_query=khat",
      label: "YouTube",
    });
    expect(extractOpenAction("[[open:https://open.spotify.com/search/khat]]")?.label).toBe("Spotify");
  });

  it("ignores ordinary answers and unsafe addresses", () => {
    expect(extractOpenAction("Time is the dimension in which events happen.")).toBeNull();
    expect(extractOpenAction("[[open:javascript:alert(1)]]")).toBeNull();
  });
});
