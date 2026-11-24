import { describe, expect, it } from "vitest";
import { extractSources } from "./grounding";

describe("extractSources", () => {
  it("reads url citations from the reply message", () => {
    const json = {
      choices: [
        {
          message: {
            content: "Answer",
            annotations: [
              { type: "url_citation", url_citation: { url: "https://example.com/a", title: "A" } },
            ],
          },
        },
      ],
    };
    expect(extractSources(json)).toEqual([{ url: "https://example.com/a", title: "A" }]);
  });

  it("reads a top-level citations list and names links by their site", () => {
    expect(extractSources({ choices: [], citations: ["https://www.news.org/story"] })).toEqual([
      { url: "https://www.news.org/story", title: "news.org" },
    ]);
  });

  it("drops links that are not plain web addresses and duplicates", () => {
    const json = { citations: ["javascript:alert(1)", "https://a.com/", "https://a.com/", "/x"] };
    expect(extractSources(json)).toEqual([{ url: "https://a.com/", title: "a.com" }]);
  });

  it("returns nothing when the provider cites nothing", () => {
    expect(extractSources({ choices: [{ message: { content: "hi" } }] })).toEqual([]);
  });
});
