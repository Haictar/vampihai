import { describe, expect, it } from "vitest";
import { imagePrompt, isImageRequest, matchVoiceCommand, parseBrowserVoiceAction } from "./commands";

describe("image requests", () => {
  it("treats picture requests as image generation", () => {
    expect(isImageRequest("Generate an image of a red fox in the snow")).toBe(true);
    expect(isImageRequest("can you draw me a picture of a cat")).toBe(true);
    expect(isImageRequest("make a logo for my bakery")).toBe(true);
    expect(isImageRequest("draw a dragon over a city")).toBe(true);
    expect(isImageRequest("/image neon sunset")).toBe(true);
    expect(isImageRequest("hey Jimmy, generate a picture of a cat")).toBe(true);
  });

  it("keeps questions and coding requests as normal chat", () => {
    expect(isImageRequest("how do I create an image in HTML?")).toBe(false);
    expect(isImageRequest("create an image upload component in React")).toBe(false);
    expect(isImageRequest("what is a good picture frame size")).toBe(false);
  });

  it("strips the /image command from the prompt", () => {
    expect(imagePrompt("/image neon sunset")).toBe("neon sunset");
  });
});

describe("spoken app commands", () => {
  it("recognises spoken navigation commands", () => {
    expect(matchVoiceCommand("New conversation.")).toBe("new_chat");
    expect(matchVoiceCommand("hey Jimmy, open the API manager")).toBe("open_api_manager");
    expect(matchVoiceCommand("open settings")).toBe("open_settings");
  });

  it("sends anything else to the chat", () => {
    expect(matchVoiceCommand("open the pod bay doors")).toBeNull();
    expect(matchVoiceCommand("write a new chat app in react")).toBeNull();
  });
});

describe("spoken stop and browser actions", () => {
  it("treats 'stop' and 'goodbye' as ending the voice conversation", () => {
    expect(matchVoiceCommand("Stop.")).toBe("stop_assistant");
    expect(matchVoiceCommand("goodbye Jimmy")).toBe("stop_assistant");
    expect(matchVoiceCommand("stop the timer at five")).toBeNull();
  });

  it("opens well-known sites by name", () => {
    expect(parseBrowserVoiceAction("hey Jimmy, open YouTube")).toEqual({
      url: "https://www.youtube.com",
      label: "YouTube",
    });
    expect(parseBrowserVoiceAction("open Spotify")).toEqual({
      url: "https://open.spotify.com",
      label: "Spotify",
    });
  });

  it("opens a spoken web address", () => {
    expect(parseBrowserVoiceAction("go to example dot com")).toEqual({
      url: "https://example.com",
      label: "example.com",
    });
  });

  it("searches Google for a spoken query", () => {
    expect(parseBrowserVoiceAction("search Google for cheap flights")).toEqual({
      url: "https://www.google.com/search?q=cheap%20flights",
      label: "Google",
    });
  });

  it("plays a request on YouTube", () => {
    expect(parseBrowserVoiceAction("play lofi beats on YouTube")).toEqual({
      url: "https://www.youtube.com/results?search_query=lofi%20beats",
      label: "YouTube",
    });
  });

  it("leaves ordinary questions for Jimmy", () => {
    expect(parseBrowserVoiceAction("what is the capital of France")).toBeNull();
    expect(parseBrowserVoiceAction("open my heart")).toBeNull();
  });
});

describe("parseBrowserVoiceAction: open an app and play something", () => {
  it("opens YouTube and plays the song asked for", () => {
    expect(parseBrowserVoiceAction("Open YouTube and play Khat on it.")).toEqual({
      url: "https://www.youtube.com/results?search_query=khat",
      label: "YouTube",
    });
    expect(parseBrowserVoiceAction("Open YouTube and play cut.")).toEqual({
      url: "https://www.youtube.com/results?search_query=cut",
      label: "YouTube",
    });
  });

  it("plays on Spotify when Spotify is named", () => {
    expect(parseBrowserVoiceAction("play Khat on Spotify")).toEqual({
      url: "https://open.spotify.com/search/khat",
      label: "Spotify",
    });
    expect(parseBrowserVoiceAction("open spotify and play lofi beats")).toEqual({
      url: "https://open.spotify.com/search/lofi%20beats",
      label: "Spotify",
    });
  });

  it("works for typed requests that name the site", () => {
    expect(parseBrowserVoiceAction("open youtube and play khat", { typed: true })?.label).toBe(
      "YouTube",
    );
    expect(parseBrowserVoiceAction("open spotify", { typed: true })?.url).toBe(
      "https://open.spotify.com",
    );
    expect(parseBrowserVoiceAction("google cheap flights", { typed: true })?.url).toBe(
      "https://www.google.com/search?q=cheap%20flights",
    );
  });

  it("leaves typed questions that don't name a site for Jimmy to answer", () => {
    expect(parseBrowserVoiceAction("play chess with me", { typed: true })).toBeNull();
    expect(parseBrowserVoiceAction("look up the meaning of life", { typed: true })).toBeNull();
    expect(parseBrowserVoiceAction("search for good recipes", { typed: true })).toBeNull();
  });
});

describe("parseBrowserVoiceAction: everyday wording", () => {
  it("opens an app named with 'app' or 'for me'", () => {
    expect(parseBrowserVoiceAction("open the Spotify app")?.url).toBe("https://open.spotify.com");
    expect(parseBrowserVoiceAction("play Khat on YouTube for me")?.url).toBe(
      "https://www.youtube.com/results?search_query=khat",
    );
  });
});
