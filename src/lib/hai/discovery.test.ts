import { describe, expect, it } from "vitest";
import {
  MODEL_LIST_ADAPTERS,
  ModelDiscoveryError,
  discoverModels,
  isModelUnavailableError,
  readStoredModels,
} from "./discovery";
import { isKeyRoutable } from "./providers";

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(
  pages: Array<{ status: number; body: unknown }>,
  calls: Call[] = [],
): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const page = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(typeof page.body === "string" ? page.body : JSON.stringify(page.body), {
      status: page.status,
    });
  }) as typeof fetch;
}

const gemini = MODEL_LIST_ADAPTERS.gemini;

describe("Google AI Studio discovery", () => {
  it("follows nextPageToken across pages and keeps only generateContent chat models", async () => {
    const calls: Call[] = [];
    const models = await discoverModels(
      gemini,
      { apiKey: "AIza-secret", baseUrl: null },
      fakeFetch(
        [
          {
            status: 200,
            body: {
              models: [
                {
                  name: "models/gemini-a",
                  displayName: "Gemini A",
                  supportedGenerationMethods: ["generateContent"],
                },
                { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
              ],
              nextPageToken: "page2",
            },
          },
          {
            status: 200,
            body: {
              models: [
                {
                  name: "models/gemini-b",
                  supportedGenerationMethods: ["generateContent", "countTokens"],
                },
                { name: "models/gemini-b-tts", supportedGenerationMethods: ["generateContent"] },
              ],
            },
          },
        ],
        calls,
      ),
    );
    expect(models.map((m) => m.id)).toEqual(["gemini-a", "gemini-b"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
    expect(calls[1]!.url).toContain("pageToken=page2");
    // The key travels in a header, never in the URL.
    expect(calls.every((c) => !c.url.includes("AIza-secret"))).toBe(true);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("AIza-secret");
  });

  it("reports an invalid key as an authentication failure", async () => {
    const err = await discoverModels(
      gemini,
      { apiKey: "bad", baseUrl: null },
      fakeFetch([
        {
          status: 400,
          body: {
            error: { message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] },
          },
        },
      ]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDiscoveryError);
    expect((err as ModelDiscoveryError).kind).toBe("auth");
  });
});

describe("shared discovery rules", () => {
  it("treats 401 from any provider as an authentication failure", async () => {
    const err = await discoverModels(
      MODEL_LIST_ADAPTERS.groq,
      { apiKey: "gsk_x", baseUrl: null },
      fakeFetch([{ status: 401, body: { error: { message: "Invalid API Key" } } }]),
    ).catch((e: unknown) => e);
    expect((err as ModelDiscoveryError).kind).toBe("auth");
  });

  it("does not mistake a model-list permission error for an invalid API key", async () => {
    const err = await discoverModels(
      MODEL_LIST_ADAPTERS.custom,
      { apiKey: "custom-secret", baseUrl: "https://api.example.com/v1" },
      fakeFetch([
        {
          status: 403,
          body: { error: { message: "Model listing is not supported on this endpoint." } },
        },
      ]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelDiscoveryError);
    expect((err as ModelDiscoveryError).kind).toBe("failed");
  });

  it("fails with no_models when the key has no chat-compatible models", async () => {
    const err = await discoverModels(
      MODEL_LIST_ADAPTERS.groq,
      { apiKey: "gsk_x", baseUrl: null },
      fakeFetch([
        { status: 200, body: { data: [{ id: "whisper-large-v3" }, { id: "llama-guard-4" }] } },
      ]),
    ).catch((e: unknown) => e);
    expect((err as ModelDiscoveryError).kind).toBe("no_models");
  });

  it("fails with a discovery error (not auth) on provider outages, without leaking the key", async () => {
    const err = await discoverModels(
      MODEL_LIST_ADAPTERS.groq,
      { apiKey: "gsk_secret", baseUrl: null },
      fakeFetch([{ status: 503, body: { error: { message: "down for gsk_secret" } } }]),
    ).catch((e: unknown) => e);
    expect((err as ModelDiscoveryError).kind).toBe("failed");
    expect((err as Error).message).not.toContain("gsk_secret");
  });

  it("drops inactive, non-chat, agent, and Interactions-only models", async () => {
    const groq = await discoverModels(
      MODEL_LIST_ADAPTERS.groq,
      { apiKey: "k", baseUrl: null },
      fakeFetch([
        {
          status: 200,
          body: {
            data: [
              { id: "llama-x", active: true },
              { id: "old-y", active: false },
              { id: "chat-agents", active: true },
              { id: "gpt-interactions-preview", active: true },
              { id: "computer-use-preview", active: true },
            ],
          },
        },
      ]),
    );
    expect(groq.map((m) => m.id)).toEqual(["llama-x"]);
    const cohere = await discoverModels(
      MODEL_LIST_ADAPTERS.cohere,
      { apiKey: "k", baseUrl: null },
      fakeFetch([
        {
          status: 200,
          body: {
            models: [
              { name: "command-z", endpoints: ["chat", "generate"] },
              { name: "embed-v4", endpoints: ["embed"] },
              { name: "command-old", endpoints: ["chat"], is_deprecated: true },
            ],
          },
        },
      ]),
    );
    expect(cohere.map((m) => m.id)).toEqual(["command-z"]);
  });

  it("uses the custom endpoint's /models list", async () => {
    const calls: Call[] = [];
    await discoverModels(
      MODEL_LIST_ADAPTERS.custom,
      { apiKey: "k", baseUrl: "https://api.example.com/v1" },
      fakeFetch([{ status: 200, body: { data: [{ id: "chat-1" }] } }], calls),
    );
    expect(calls[0]!.url).toBe("https://api.example.com/v1/models");
  });
});

describe("retired models", () => {
  it("recognises model-gone errors but not quota or bad-key errors", () => {
    expect(isModelUnavailableError(404, "Model or endpoint not found")).toBe(true);
    expect(isModelUnavailableError(400, "The model `x` has been decommissioned")).toBe(true);
    expect(isModelUnavailableError(403, "You are not authorized to access this model")).toBe(true);
    expect(isModelUnavailableError(429, "Rate limit reached for model x")).toBe(false);
    expect(isModelUnavailableError(401, "Invalid API Key")).toBe(false);
  });

  it("only routes a key whose selected model is still in its discovered list", () => {
    const models = readStoredModels([{ id: "m1", name: "M1" }]);
    expect(isKeyRoutable({ model: "m1", models })).toBe(true);
    expect(isKeyRoutable({ model: "gone", models })).toBe(false);
    expect(isKeyRoutable({ model: null, models })).toBe(false);
  });

  it("preserves model health and failure reasons from stored JSON", () => {
    expect(
      readStoredModels([
        { id: "chat-a", name: "Chat A", health: "available", error: null },
        { id: "chat-b", name: "Chat B", health: "unavailable", error: "Access denied" },
        { id: "chat-c", name: "Chat C" },
      ]),
    ).toEqual([
      { id: "chat-a", name: "Chat A", kind: "chat", health: "available", error: null },
      { id: "chat-b", name: "Chat B", kind: "chat", health: "unavailable", error: "Access denied" },
      { id: "chat-c", name: "Chat C", kind: "chat", health: "untested", error: null },
    ]);
  });

  it("keeps image models apart from chat models", () => {
    expect(readStoredModels([{ id: "pic", name: "Pic", kind: "image" }])[0]?.kind).toBe("image");
    expect(readStoredModels([{ id: "old", name: "Old" }])[0]?.kind).toBe("chat");
  });
});
