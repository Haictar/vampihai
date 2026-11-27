import { describe, expect, it } from "vitest";
import { findWakeWord, pickFemaleVoice, readQuestionAfterWake } from "./voice";

describe("findWakeWord", () => {
  it("hears 'Hello Jimmy' however the browser spells Jimmy", () => {
    for (const heard of ["Hello Jimmy", "hello jimmy", "Hello, Jimmy!", "hello Jimmie"]) {
      expect(findWakeWord(heard)).toEqual({ rest: "" });
    }
  });

  it("returns the question said right after the wake word", () => {
    expect(findWakeWord("hello jimmy what time is it in Tokyo")).toEqual({
      rest: "what time is it in Tokyo",
    });
  });

  it("ignores speech without the wake word", () => {
    expect(findWakeWord("what is the weather")).toBeNull();
    expect(findWakeWord("hello there")).toBeNull();
    expect(findWakeWord("hello highway")).toBeNull();
    expect(findWakeWord("hello hai")).toBeNull();
    expect(findWakeWord("hello jimmykins")).toBeNull();
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

describe("readQuestionAfterWake", () => {
  it("keeps listening when only the wake word was said", () => {
    expect(readQuestionAfterWake([{ transcript: "hello jimmy", isFinal: true }], 0, true)).toEqual({
      text: "",
      done: false,
    });
  });

  it("sends the words said in the same breath as the wake word", () => {
    expect(
      readQuestionAfterWake([{ transcript: "hello jimmy open youtube", isFinal: true }], 0, true),
    ).toEqual({ text: "open youtube", done: true });
  });

  it("waits while the person is still speaking", () => {
    expect(
      readQuestionAfterWake([{ transcript: "hello jimmy what is the", isFinal: false }], 0, true),
    ).toEqual({ text: "what is the", done: false });
  });

  it("joins a question asked after a short pause", () => {
    expect(
      readQuestionAfterWake(
        [
          { transcript: "something earlier", isFinal: true },
          { transcript: "hello jimmy", isFinal: true },
          { transcript: "what time is it", isFinal: true },
        ],
        1,
        true,
      ),
    ).toEqual({ text: "what time is it", done: true });
  });

  it("reads a follow-up question without needing the wake word", () => {
    expect(
      readQuestionAfterWake([{ transcript: "and tomorrow", isFinal: true }], 0, false),
    ).toEqual({ text: "and tomorrow", done: true });
  });
});
