import { describe, expect, it } from "vitest";
import { CODE_ONLY_SPEECH, MAX_SPOKEN_CHARS, speakableText } from "./speakable";

describe("speakableText", () => {
  it("never reads a code block aloud", () => {
    const text = speakableText("Here is it.\n\n```python\nprint('hello')\n```\n\nRun it.");
    expect(text).toBe("Here is it. Run it.");
  });

  it("skips a code block the model never closed", () => {
    expect(speakableText("Try this:\n```js\nconst a = 1;")).toBe("Try this:");
  });

  it("skips code-looking inline code but keeps plain words", () => {
    expect(speakableText("Call `fetch(url)` from `React`.")).toBe("Call from React.");
  });

  it("says the code is on screen when the reply is only code", () => {
    expect(speakableText("```ts\nlet x = 2;\n```")).toBe(CODE_ONLY_SPEECH);
  });

  it("stops at a sentence end within the spoken limit", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const spoken = speakableText(long);
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(spoken.endsWith("here.")).toBe(true);
    expect(spoken.startsWith("Sentence number 0 is here.")).toBe(true);
  });

  it("leaves out links and emoji", () => {
    expect(speakableText("See [the docs](https://x.dev) 🚀 at https://x.dev now.")).toBe(
      "See the docs at now.",
    );
  });
});
