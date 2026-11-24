import { describe, expect, it } from "vitest";
import {
  MAX_ROUTE_ATTEMPTS,
  modelQualityScore,
  orderKeysForFailover,
  orderPreferredCandidates,
  orderRouteCandidates,
  validateCustomBaseUrl,
  type KeyStatus,
} from "./providers";

const key = (id: string, provider: string, status: KeyStatus, created_at: string) => ({
  id,
  provider,
  status,
  created_at,
});

describe("failover order", () => {
  it("tries the next key of the same provider before switching provider", () => {
    const order = orderKeysForFailover([
      key("groq-1", "groq", "healthy", "2026-01-01"),
      key("gemini-1", "gemini", "healthy", "2026-01-02"),
      key("groq-2", "groq", "untested", "2026-01-03"),
    ]).map((k) => k.id);
    expect(order).toEqual(["groq-1", "groq-2", "gemini-1"]);
  });

  it("puts unhealthy keys last within a provider", () => {
    const order = orderKeysForFailover([
      key("a", "groq", "unhealthy", "2026-01-01"),
      key("b", "groq", "healthy", "2026-01-02"),
    ]).map((k) => k.id);
    expect(order).toEqual(["b", "a"]);
  });
});

describe("custom endpoints are cloud-only", () => {
  it("rejects Ollama and local addresses", () => {
    expect(validateCustomBaseUrl("http://localhost:11434/v1").ok).toBe(false);
    expect(validateCustomBaseUrl("https://127.0.0.1/v1").ok).toBe(false);
    expect(validateCustomBaseUrl("https://192.168.1.5/v1").ok).toBe(false);
    expect(validateCustomBaseUrl("https://my-ollama.example.com/v1").ok).toBe(false);
  });

  it("accepts a public https endpoint and strips /chat/completions", () => {
    expect(validateCustomBaseUrl("https://api.together.xyz/v1/chat/completions")).toEqual({
      ok: true,
      url: "https://api.together.xyz/v1",
    });
  });
});

describe("auto routing to the next best model", () => {
  const k = (
    id: string,
    provider: string,
    status: KeyStatus,
    created_at: string,
    models: { id: string; health: string }[],
  ) => ({ id, provider, status, created_at, models });
  const ok = (id: string) => ({ id, health: "available" });

  it("tries the chosen model first, then the best other model", () => {
    const order = orderRouteCandidates(
      [
        k("groq", "groq", "healthy", "2026-01-01", [ok("llama-3.1-8b-instant"), ok("llama-3.3-70b-versatile")]),
        k("gemini", "gemini", "healthy", "2026-01-02", [ok("gemini-2.5-flash-lite"), ok("gemini-2.5-pro")]),
      ],
      { provider: "groq", model: "llama-3.1-8b-instant", keyId: "groq" },
    ).map((c) => c.model);
    expect(order[0]).toBe("llama-3.1-8b-instant");
    expect(order[1]).toBe("gemini-2.5-pro");
    expect(order).toHaveLength(4);
  });

  it("tries the chosen model on the same provider's other key before switching model", () => {
    const order = orderRouteCandidates(
      [
        k("g1", "groq", "healthy", "2026-01-01", [ok("m-a"), ok("m-b")]),
        k("g2", "groq", "healthy", "2026-01-02", [ok("m-a")]),
      ],
      { provider: "groq", model: "m-a", keyId: "g1" },
    ).map((c) => `${c.key.id}:${c.model}`);
    expect(order.slice(0, 3)).toEqual(["g1:m-a", "g2:m-a", "g1:m-b"]);
  });

  it("never routes to unhealthy keys or unavailable models", () => {
    const order = orderRouteCandidates(
      [
        k("bad", "groq", "unhealthy", "2026-01-01", [ok("llama-3.3-70b-versatile")]),
        k("good", "gemini", "healthy", "2026-01-02", [
          ok("gemini-2.5-flash"),
          { id: "gemini-2.5-pro", health: "unavailable" },
        ]),
      ],
      null,
    ).map((c) => c.model);
    expect(order).toEqual(["gemini-2.5-flash"]);
  });

  it("stops after the attempt limit", () => {
    const models = Array.from({ length: 10 }, (_, i) => ok(`model-${i}`));
    const order = orderRouteCandidates([k("a", "groq", "healthy", "2026-01-01", models)], null);
    expect(order).toHaveLength(MAX_ROUTE_ATTEMPTS);
  });

  it("ranks bigger and higher-tier models above small ones", () => {
    expect(modelQualityScore("llama-3.3-70b-versatile")).toBeGreaterThan(
      modelQualityScore("llama-3.1-8b-instant"),
    );
    expect(modelQualityScore("gemini-2.5-pro")).toBeGreaterThan(
      modelQualityScore("gemini-2.5-flash-lite"),
    );
  });
});

describe("orderPreferredCandidates", () => {
  const key = (id: string, status: "healthy" | "unhealthy", models: string[]) => ({
    id,
    provider: "groq",
    status,
    created_at: "2026-01-01",
    models: models.map((m) => ({ id: m, health: "available" })),
  });

  it("tries the person's pinned models first, then the usual order", () => {
    const a = key("a", "healthy", ["m1", "m2"]);
    const order = orderPreferredCandidates(
      [a],
      [{ provider: "groq", model: "m2", keyId: "a" }],
      [
        { key: a, model: "m1" },
        { key: a, model: "m2" },
      ],
    );
    expect(order.map((c) => c.model)).toEqual(["m2", "m1"]);
  });

  it("skips pinned models on broken keys or that are no longer available", () => {
    const broken = key("b", "unhealthy", ["m1"]);
    const ok = key("c", "healthy", ["m3"]);
    const order = orderPreferredCandidates(
      [broken, ok],
      [
        { provider: "groq", model: "m1", keyId: "b" },
        { provider: "groq", model: "gone", keyId: "c" },
      ],
      [{ key: ok, model: "m3" }],
    );
    expect(order.map((c) => `${c.key.id}:${c.model}`)).toEqual(["c:m3"]);
  });
});
