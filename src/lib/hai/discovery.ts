// Reusable model discovery: each provider declares how to read its official model-list API,
// and one shared loop handles auth, pagination, capability filtering and error reporting.
// Pure (fetch is injected), so it is unit-tested and never touches stored secrets itself.
import type { ProviderId } from "./providers";

export interface DiscoveredModel {
  id: string;
  name: string;
}

export type ModelHealth = "available" | "unavailable" | "untested";

/** What a stored model does: answer chats, or make pictures. Older rows without a kind are chat models. */
export type ModelKind = "chat" | "image";

export interface StoredModel extends DiscoveredModel {
  kind: ModelKind;
  health: ModelHealth;
  error: string | null;
}

export type DiscoveryErrorKind = "auth" | "no_models" | "failed";

export class ModelDiscoveryError extends Error {
  constructor(
    public readonly kind: DiscoveryErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

export interface ModelListAdapter {
  /** True when the model-list call itself proves the key is valid (it requires auth). */
  listVerifiesKey: boolean;
  /** Builds the URL for one page. `pageToken` is undefined for the first page. */
  pageUrl(ctx: { baseUrl: string | null; pageToken: string | undefined }): string;
  headers(apiKey: string): Record<string, string>;
  /** Reads one page of the provider's response. */
  parsePage(json: unknown): { items: unknown[]; nextPageToken: string | null };
  /** Returns the model when it can serve HAI's text chat, or null to hide it. */
  toChatModel(item: unknown): DiscoveredModel | null;
  /** Extra provider-specific signals that a non-2xx means "bad key". */
  isAuthFailure?(status: number, body: string): boolean;
}

/** Model families that cannot answer a text chat (audio, images, embeddings, safety classifiers…). */
const NON_CHAT_PATTERN =
  /(embed|whisper|tts|speech|transcri|audio|dall-e|image-gen|imagen|veo|moderation|rerank|retriever|guard|safety|nvclip|\bclip\b|orpheus|playai|detector|pii|aqa|lyria|sora|gpt-image|-image\b|music|(^|[-_/])agents?($|[-_/])|interaction|computer[-_/]?use)/i;

export function looksLikeChatModel(id: string): boolean {
  return !NON_CHAT_PATTERN.test(id);
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Any provider exposing the OpenAI-style `GET {base}/models` → `{ data: [{ id }] }` contract. */
export function openAIStyleAdapter(opts: {
  baseUrl?: string;
  listVerifiesKey: boolean;
  accept?: (item: Record<string, unknown>) => boolean;
}): ModelListAdapter {
  return {
    listVerifiesKey: opts.listVerifiesKey,
    pageUrl: ({ baseUrl }) => {
      const base = opts.baseUrl ?? baseUrl;
      if (!base)
        throw new ModelDiscoveryError("failed", "Model discovery failed: no endpoint configured.");
      return `${base.replace(/\/+$/, "")}/models`;
    },
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" }),
    parsePage: (json) => {
      const o = obj(json);
      return { items: list(o?.["data"] ?? o?.["models"] ?? json), nextPageToken: null };
    },
    toChatModel: (item) => {
      const o = obj(item);
      const id = str(o?.["id"]);
      if (!o || !id || !looksLikeChatModel(id)) return null;
      if (o["active"] === false) return null;
      if (opts.accept && !opts.accept(o)) return null;
      return { id, name: id };
    },
  };
}

export const geminiAdapter: ModelListAdapter = {
  listVerifiesKey: true,
  pageUrl: ({ pageToken }) =>
    withQuery("https://generativelanguage.googleapis.com/v1beta/models", {
      pageSize: "1000",
      pageToken,
    }),
  // Header (not ?key=) keeps the key out of URLs and any request logs.
  headers: (apiKey) => ({ "x-goog-api-key": apiKey, accept: "application/json" }),
  parsePage: (json) => {
    const o = obj(json);
    return { items: list(o?.["models"]), nextPageToken: str(o?.["nextPageToken"]) };
  },
  toChatModel: (item) => {
    const o = obj(item);
    const name = str(o?.["name"]);
    if (!o || !name) return null;
    const methods = list(o["supportedGenerationMethods"]);
    if (!methods.includes("generateContent")) return null;
    const id = name.replace(/^models\//, "");
    if (!looksLikeChatModel(id) || /(-image|live|native-audio|robotics|computer-use)/i.test(id))
      return null;
    return { id, name: str(o["displayName"]) ?? id };
  },
  isAuthFailure: (status, body) =>
    status === 400 && /API_KEY_INVALID|API key not valid/i.test(body),
};

export const cohereAdapter: ModelListAdapter = {
  listVerifiesKey: true,
  pageUrl: ({ pageToken }) =>
    withQuery("https://api.cohere.com/v1/models", {
      endpoint: "chat",
      page_size: "1000",
      page_token: pageToken,
    }),
  headers: (apiKey) => ({ authorization: `Bearer ${apiKey}`, accept: "application/json" }),
  parsePage: (json) => {
    const o = obj(json);
    return { items: list(o?.["models"]), nextPageToken: str(o?.["next_page_token"]) };
  },
  toChatModel: (item) => {
    const o = obj(item);
    const id = str(o?.["name"]);
    if (!o || !id || o["is_deprecated"] === true) return null;
    if (!list(o["endpoints"]).includes("chat") || !looksLikeChatModel(id)) return null;
    return { id, name: id };
  },
};

/** Registry: add a provider here with its official model-list adapter. */
export const MODEL_LIST_ADAPTERS: Record<ProviderId, ModelListAdapter> = {
  gemini: geminiAdapter,
  groq: openAIStyleAdapter({ baseUrl: "https://api.groq.com/openai/v1", listVerifiesKey: true }),
  // NVIDIA's catalog is public, so the key is verified separately with a tiny chat call.
  nvidia: openAIStyleAdapter({
    baseUrl: "https://integrate.api.nvidia.com/v1",
    listVerifiesKey: false,
  }),
  cohere: cohereAdapter,
  // Unknown hosts may serve /models without checking the key.
  custom: openAIStyleAdapter({ listVerifiesKey: false }),
};

const MAX_PAGES = 20;

function providerError(body: string): string {
  try {
    const o = obj(JSON.parse(body));
    const err = o?.["error"];
    return str(obj(err)?.["message"]) ?? str(err) ?? str(o?.["message"]) ?? "";
  } catch {
    return "";
  }
}

export const DISCOVERY_MESSAGES = {
  auth: "Authentication failed: the provider rejected this API key.",
  noModels: "No chat-compatible models are available to this key.",
} as const;

/** Fetches every page of a provider's model list and keeps only chat-capable models. */
export async function discoverModels(
  adapter: ModelListAdapter,
  ctx: { apiKey: string; baseUrl: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const scrub = (text: string) => text.split(ctx.apiKey).join("[key]").slice(0, 160);
  const found = new Map<string, DiscoveredModel>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(adapter.pageUrl({ baseUrl: ctx.baseUrl, pageToken }), {
        method: "GET",
        headers: adapter.headers(ctx.apiKey),
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (error instanceof ModelDiscoveryError) throw error;
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ModelDiscoveryError(
        "failed",
        `Model discovery failed: ${timedOut ? "the provider timed out" : "could not reach the provider"}.`,
      );
    }
    const body = await res.text();
    const indicatesBadCredentials =
      res.status === 403 &&
      /(api[\s_-]?key|token|credential|unauthori[sz]ed|authentication)/i.test(body);
    if (
      res.status === 401 ||
      indicatesBadCredentials ||
      adapter.isAuthFailure?.(res.status, body)
    ) {
      const detail = scrub(providerError(body));
      throw new ModelDiscoveryError(
        "auth",
        detail ? `${DISCOVERY_MESSAGES.auth} ${detail}` : DISCOVERY_MESSAGES.auth,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ModelDiscoveryError(
        "failed",
        "Model discovery failed: the endpoint tried to redirect.",
      );
    }
    if (!res.ok) {
      const detail = scrub(providerError(body));
      throw new ModelDiscoveryError(
        "failed",
        `Model discovery failed (${res.status}${res.status === 429 ? ", rate limited" : ""})${detail ? `: ${detail}` : "."}`,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new ModelDiscoveryError(
        "failed",
        "Model discovery failed: the provider returned an unreadable list.",
      );
    }
    const { items, nextPageToken } = adapter.parsePage(json);
    for (const item of items) {
      const model = adapter.toChatModel(item);
      if (model && !found.has(model.id)) found.set(model.id, model);
    }
    if (!nextPageToken || seenTokens.has(nextPageToken)) break;
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  const models = [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) throw new ModelDiscoveryError("no_models", DISCOVERY_MESSAGES.noModels);
  return models;
}

/** Reads the stored model list back from the database's JSON column. */
export function readStoredModels(value: unknown): StoredModel[] {
  return list(value).flatMap((item) => {
    const o = obj(item);
    const id = str(o?.["id"]);
    if (!id) return [];
    const health = o?.["health"];
    return [
      {
        id,
        name: str(o?.["name"]) ?? id,
        kind: o?.["kind"] === "image" ? ("image" as const) : ("chat" as const),
        health: health === "available" || health === "unavailable" ? health : "untested",
        error: str(o?.["error"]),
      },
    ];
  });
}

/** True when a failed chat call means the selected model is retired, missing or no longer allowed. */
export function isModelUnavailableError(status: number, message: string): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 403 && status !== 410 && status !== 422) return false;
  return (
    status === 410 ||
    (/model/i.test(message) &&
      /(not found|does not exist|decommission|deprecat|retired|no longer|not supported|unavailable|not available|do(es)? not have access|not have access|unknown|not authorized|unauthori[sz]ed|permission|forbidden|not allowed|access denied)/i.test(
        message,
      ))
  );
}
