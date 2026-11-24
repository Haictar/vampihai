import { describe, expect, it } from "vitest";
import { findWakeWord, pickFemaleVoice } from "./voice";

describe("findWakeWord", () => {
  it("hears 'Hello HAI' however the browser spells HAI", () => {
    for (const heard of ["Hello HAI", "hello hi", "Hello, high", "hello hey", "hello AI", "Hello H.A.I."]) {
      expect(findWakeWord(heard)).toEqual({ rest: "" });
    }
  });

  it("returns the question said right after the wake word", () => {
    expect(findWakeWord("hello hai what time is it in Tokyo")).toEqual({
      rest: "what time is it in Tokyo",
    });
  });

  it("ignores speech without the wake word", () => {
    expect(findWakeWord("what is the weather")).toBeNull();
    expect(findWakeWord("hello there")).toBeNull();
    expect(findWakeWord("hello highway")).toBeNull();
  });
});

describe("pickFemaleVoice", () => {
  const voices = [
    { name: "Microsoft David - English (United States)", lang: "en-US" },
    { name: "Microsoft Zira - English (United States)", lang: "en-US" },
    { name: "Microsoft Ravi - English (India)", lang: "en-IN" },
    { name: "Microsoft Heera - English (India)", lang: "en-IN" },
    { name: "Google UK English Male", lang: "en-GB" },
  ];

  it("chooses a female voice in the person's own language", () => {
    expect(pickFemaleVoice(voices, "en-IN")?.name).toContain("Heera");
  });

  it("never chooses a male voice when a female one exists", () => {
    expect(pickFemaleVoice(voices, "en-US")?.name).toContain("Zira");
    expect(pickFemaleVoice(voices, "en-GB")?.name).not.toMatch(/male$/i);
  });

  it("returns null when the browser has no voices yet", () => {
    expect(pickFemaleVoice([], "en-US")).toBeNull();
  });
});
