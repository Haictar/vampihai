import { describe, expect, it } from "vitest";
import { imagePrompt, isImageRequest, matchVoiceCommand, parseBrowserVoiceAction } from "./commands";

describe("image requests", () => {
  it("treats picture requests as image generation", () => {
    expect(isImageRequest("Generate an image of a red fox in the snow")).toBe(true);
    expect(isImageRequest("can you draw me a picture of a cat")).toBe(true);
    expect(isImageRequest("make a logo for my bakery")).toBe(true);
    expect(isImageRequest("draw a dragon over a city")).toBe(true);
    expect(isImageRequest("/image neon sunset")).toBe(true);
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
    expect(matchVoiceCommand("hey HAI, open the API manager")).toBe("open_api_manager");
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
    expect(matchVoiceCommand("goodbye HAI")).toBe("stop_assistant");
    expect(matchVoiceCommand("stop the timer at five")).toBeNull();
  });

  it("opens well-known sites by name", () => {
    expect(parseBrowserVoiceAction("open YouTube")).toEqual({
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

  it("leaves ordinary questions for HAI", () => {
    expect(parseBrowserVoiceAction("what is the capital of France")).toBeNull();
    expect(parseBrowserVoiceAction("open my heart")).toBeNull();
  });
});
