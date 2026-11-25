// Server-only helpers for the HAI router: provider calls, key storage and health tracking.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { extractSources, type GroundingSource } from "./grounding";
import { decryptSecret, encryptSecret } from "./crypto.server";
import type { Json } from "@/integrations/supabase/types";
import {
  MODEL_LIST_ADAPTERS,
  ModelDiscoveryError,
  discoverModels,
  isModelUnavailableError,
  readStoredModels,
  type DiscoveredModel,
  type StoredModel,
} from "./discovery";
import { getProvider, modelQualityScore, type KeyStatus, type ProviderId } from "./providers";

/** Models probed when a key is added or refreshed; the rest stay "untested" so adding a key is fast. */
export const MAX_PROBED_MODELS = 12;
const PROBE_CONCURRENCY = 12;

export function pickModelsToProbe(ids: string[]): string[] {
  return [...ids].sort((a, b) => modelQualityScore(b) - modelQualityScore(a)).slice(0, MAX_PROBED_MODELS);
}

export const KEY_COLUMNS =
  "id, provider, model, models, models_refreshed_at, models_error, label, base_url, status, last_error, last_tested_at, last_used_at, created_at" as const;

export type ChatPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  /** Plain text, or text plus images in the OpenAI-compatible content-parts format. */
  content: string | ChatPart[];
}

export type CallResult =
  | { ok: true; text: string; sources: GroundingSource[] }
  | { ok: false; status: number; error: string };

export function resolveBaseUrl(provider: ProviderId, baseUrl: string | null): string {
  const url = provider === "custom" ? baseUrl : getProvider(provider).baseUrl;
  if (!url) throw new Error("This key has no endpoint configured.");
  return url;
}

function providerMessage(raw: string): string {
  try {
    const json = JSON.parse(raw) as unknown;
    const candidate = Array.isArray(json) ? json[0] : json;
    if (candidate && typeof candidate === "object") {
      const err = (candidate as Record<string, unknown>)["error"];
      if (typeof err === "string") return err;
      if (err && typeof err === "object") {
        const msg = (err as Record<string, unknown>)["message"];
        if (typeof msg === "string") return msg;
      }
      const msg = (candidate as Record<string, unknown>)["message"];
      if (typeof msg === "string") return msg;
    }
  } catch {
    // not JSON
  }
  return "";
}

function describeFailure(status: number, raw: string, apiKey: string): string {
  const base =
    status === 401 || status === 403
      ? "Key rejected (invalid or no access)"
      : status === 429
        ? "Rate limit or quota reached"
        : status === 404
          ? "Model or endpoint not found"
          : status === 400
            ? "Request rejected by provider"
            : status >= 500
              ? "Provider is having problems"
              : `Provider error (${status})`;
  const detail = providerMessage(raw).split(apiKey).join("[key]").slice(0, 160);
  return detail ? `${base}: ${detail}` : base;
}

function extractText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const choices = (json as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as Record<string, unknown> | undefined)?.["message"];
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>)["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === "object"
                ? String((part as Record<string, unknown>)["text"] ?? "")
                : "",
            )
            .join("")
        : "";
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function callChatCompletion(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  maxTokens?: number;
  timeoutMs: number;
}): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.maxTokens !== undefined) body["max_tokens"] = opts.maxTokens;
  try {
    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const raw = await res.text();
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, error: "Endpoint tried to redirect; not allowed" };
    }
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        error: describeFailure(res.status, raw, opts.apiKey),
      };
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, status: 502, error: "Provider returned an unreadable response" };
    }
    return { ok: true, text: extractText(json), sources: extractSources(json) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, status: 0, error: "Provider timed out" };
    }
    return { ok: false, status: 0, error: "Could not reach the provider" };
  }
}

/** Stored-key row shape the helpers below need. */
export interface StoredKeyRow {
  id: string;
  provider: string;
  model: string | null;
  models: Json;
  base_url: string | null;
}

function modelsJson(models: readonly (DiscoveredModel | StoredModel)[]) {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    kind: "kind" in m ? m.kind : "chat",
    health: "health" in m ? m.health : "untested",
    error: "error" in m ? m.error : null,
  }));
}

export const AUTH_FAILED_MESSAGE = "Authentication failed: the provider rejected this API key.";

/** Runs the provider's official model-list discovery for a raw key (never logged). */
export function discoverProviderModels(
  provider: ProviderId,
  apiKey: string,
  baseUrl: string | null,
) {
  return discoverModels(MODEL_LIST_ADAPTERS[provider], { apiKey, baseUrl });
}

export async function createStoredKey(input: {
  userId: string;
  provider: ProviderId;
  status: KeyStatus;
  lastError?: string | null;
  modelsError?: string | null;
  models: DiscoveredModel[];
  label: string;
  baseUrl: string | null;
  apiKey: string;
}) {
  const { data: row, error } = await supabaseAdmin
    .from("api_keys")
    .insert({
      user_id: input.userId,
      provider: input.provider,
      model: null,
      models: modelsJson(input.models),
      models_refreshed_at: new Date().toISOString(),
      models_error: input.modelsError ?? null,
      label: input.label,
      base_url: input.baseUrl,
      status: input.status,
      last_error: input.lastError ?? null,
    })
    .select(KEY_COLUMNS)
    .single();
  if (error || !row) {
    console.error("api_keys insert failed", error?.message);
    throw new Error("Could not save the key.");
  }
  try {
    const sealed = await encryptSecret(input.apiKey, row.id);
    const { error: secretError } = await supabaseAdmin
      .from("api_key_secrets")
      .insert({ key_id: row.id, ciphertext: sealed.ciphertext, iv: sealed.iv });
    if (secretError) throw new Error(secretError.message);
  } catch (err) {
    console.error("api_key_secrets insert failed", err instanceof Error ? err.message : err);
    await supabaseAdmin.from("api_keys").delete().eq("id", row.id);
    throw new Error("Could not save the key securely.");
  }
  return row;
}

export async function loadSecrets(keyIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (keyIds.length === 0) return result;
  const { data, error } = await supabaseAdmin
    .from("api_key_secrets")
    .select("key_id, ciphertext, iv")
    .in("key_id", keyIds);
  if (error) throw new Error("Could not load stored keys.");
  for (const row of data ?? []) {
    try {
      result.set(row.key_id, await decryptSecret(row.ciphertext, row.iv, row.key_id));
    } catch {
      console.error("Failed to decrypt key", row.key_id);
    }
  }
  return result;
}

export async function recordKeyResult(
  keyId: string,
  status: KeyStatus,
  error: string | null,
  usedForChat: boolean,
) {
  const now = new Date().toISOString();
  const patch: {
    status: KeyStatus;
    last_error: string | null;
    last_tested_at: string;
    last_used_at?: string;
  } = { status, last_error: error, last_tested_at: now };
  if (usedForChat && status === "healthy") patch.last_used_at = now;
  const { data, error: updateError } = await supabaseAdmin
    .from("api_keys")
    .update(patch)
    .eq("id", keyId)
    .select(KEY_COLUMNS)
    .single();
  if (updateError || !data) throw new Error("Could not update API key health.");
  return data;
}

async function updateStoredModel(
  row: StoredKeyRow,
  modelId: string,
  health: StoredModel["health"],
  error: string | null,
) {
  const models = readStoredModels(row.models).map((model) =>
    model.id === modelId ? { ...model, health, error } : model,
  );
  return updateKey(row.id, { models: modelsJson(models) });
}

export async function testStoredModel(row: StoredKeyRow, modelId: string, knownApiKey?: string) {
  const model = readStoredModels(row.models).find((candidate) => candidate.id === modelId);
  if (!model)
    throw new Error("That model is no longer in this key's discovered catalog. Refresh models.");
  const apiKey = knownApiKey ?? (await loadSecrets([row.id])).get(row.id);
  if (!apiKey) {
    await updateStoredModel(row, modelId, "unavailable", "Stored key could not be read.");
    await recordKeyResult(row.id, "unhealthy", "Stored key could not be read", false);
    return row;
  }
  const result = await probeStoredModel(row, modelId, apiKey);
  const updated = await updateStoredModel(row, modelId, result.health, result.error);
  if (result.health === "available") {
    return (await recordKeyResult(row.id, "healthy", null, false)) ?? updated;
  }
  if (result.authFailure) {
    return (await recordKeyResult(row.id, "unhealthy", result.error, false)) ?? updated;
  }
  return updated;
}

async function probeStoredModel(row: StoredKeyRow, modelId: string, apiKey: string) {
  const result = await callChatCompletion({
    baseUrl: resolveBaseUrl(row.provider as ProviderId, row.base_url),
    apiKey,
    model: modelId,
    messages: [{ role: "user", content: "Reply with OK." }],
    maxTokens: 16,
    timeoutMs: 12000,
  });
  if (result.ok && result.text) {
    return { health: "available" as const, error: null, authFailure: false };
  }
  const error = result.ok ? "Provider returned an empty reply." : result.error;
  const authFailure =
    !result.ok &&
    (result.status === 401 || result.status === 403) &&
    !isModelUnavailableError(result.status, result.error);
  return { health: "unavailable" as const, error, authFailure };
}

export async function testStoredModels(
  row: StoredKeyRow,
  knownApiKey?: string,
  listVerifiesKey = false,
  modelIds?: string[],
) {
  const models = readStoredModels(row.models);
  const wanted = new Set(pickModelsToProbe(modelIds ?? models.map((model) => model.id)));
  const candidates = models.filter((model) => wanted.has(model.id));
  const apiKey = knownApiKey ?? (await loadSecrets([row.id])).get(row.id);
  if (!apiKey) {
    const error = "Stored key could not be read.";
    await recordKeyResult(row.id, "unhealthy", error, false);
    return updateKey(row.id, {
      models: modelsJson(models.map((model) => ({ ...model, health: "unavailable", error }))),
    });
  }
  const results: Array<Awaited<ReturnType<typeof probeStoredModel>>> = [];
  for (let offset = 0; offset < candidates.length; offset += PROBE_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + PROBE_CONCURRENCY);
    results.push(
      ...(await Promise.all(batch.map((model) => probeStoredModel(row, model.id, apiKey)))),
    );
  }
  const resultById = new Map(candidates.map((model, index) => [model.id, results[index]!]));
  const tested = models.map((model) => {
    const result = resultById.get(model.id);
    return result ? { ...model, health: result.health, error: result.error } : model;
  });
  const updated = await updateKey(row.id, { models: modelsJson(tested) });
  const hasAvailableModel = tested.some((model) => model.health === "available");
  const authFailure = results.find((result) => result.authFailure);
  if (hasAvailableModel || listVerifiesKey) {
    return (await recordKeyResult(row.id, "healthy", null, false)) ?? updated;
  }
  if (authFailure) {
    return (await recordKeyResult(row.id, "unhealthy", authFailure.error, false)) ?? updated;
  }
  return updated;
}

/** Re-discovers and tests every chat-capable model without changing key health for model errors. */
export async function refreshStoredKeyModels(row: StoredKeyRow, knownApiKey?: string) {
  const apiKey = knownApiKey ?? (await loadSecrets([row.id])).get(row.id);
  if (!apiKey) {
    const message = "Model discovery failed: the stored key could not be read.";
    await recordKeyResult(row.id, "unhealthy", message, false);
    return updateKey(row.id, { models_error: message });
  }
  const provider = row.provider as ProviderId;
  try {
    const models = await discoverProviderModels(provider, apiKey, row.base_url);
    const discovered = new Set(models.map((model) => model.id));
    const previous = readStoredModels(row.models);
    const merged: StoredModel[] = [
      ...models.map((model) => ({
        ...model,
        kind: "chat" as const,
        health: "untested" as const,
        error: null,
      })),
      ...previous
        .filter((model) => !discovered.has(model.id))
        .map((model) => ({
          ...model,
          health: "unavailable" as const,
          error: "This model is no longer returned by the provider's chat model list.",
        })),
    ];
    const updated = await updateKey(row.id, {
      models: modelsJson(merged),
      models_refreshed_at: new Date().toISOString(),
      models_error: null,
    });
    return updated
      ? testStoredModels(
          updated,
          apiKey,
          MODEL_LIST_ADAPTERS[provider].listVerifiesKey,
          models.map((model) => model.id),
        )
      : updated;
  } catch (error) {
    const message =
      error instanceof ModelDiscoveryError
        ? error.message
        : "Model discovery failed: unexpected error.";
    if (!(error instanceof ModelDiscoveryError)) console.error("model discovery crashed", row.id);
    const kind = error instanceof ModelDiscoveryError ? error.kind : "failed";
    const now = new Date().toISOString();
    if (kind === "auth") await recordKeyResult(row.id, "unhealthy", message, false);
    if (kind === "no_models" && MODEL_LIST_ADAPTERS[provider].listVerifiesKey) {
      await recordKeyResult(row.id, "healthy", null, false);
    }
    const models =
      kind === "no_models"
        ? readStoredModels(row.models).map((model) => ({
            ...model,
            health: "unavailable" as const,
            error: message,
          }))
        : kind === "auth"
          ? readStoredModels(row.models).map((model) => ({
              ...model,
              health: "unavailable" as const,
              error: message,
            }))
          : undefined;
    return updateKey(row.id, {
      models_error: message,
      models_refreshed_at: now,
      ...(models ? { models: modelsJson(models) } : {}),
    });
  }
}

async function updateKey(
  id: string,
  patch: {
    model?: string | null;
    models?: { id: string; name: string; health: StoredModel["health"]; error: string | null }[];
    models_refreshed_at?: string;
    models_error?: string | null;
    status?: KeyStatus;
    last_error?: string | null;
    last_tested_at?: string;
  },
) {
  const { data, error } = await supabaseAdmin
    .from("api_keys")
    .update(patch)
    .eq("id", id)
    .select(KEY_COLUMNS)
    .single();
  if (error || !data) {
    console.error("api_keys update failed", id, error?.message);
    throw new Error("Could not update API key models.");
  }
  return data;
}

/**
 * Records a failed call. When the failure says the model is gone, the model list is refreshed
 * right away so a retired model is cleared instead of being retried.
 */
export async function recordFailure(
  row: StoredKeyRow,
  modelId: string,
  status: number,
  error: string,
  usedForChat: boolean,
) {
  const updated = await updateStoredModel(row, modelId, "unavailable", error);
  if ((status === 401 || status === 403) && !isModelUnavailableError(status, error)) {
    return (await recordKeyResult(row.id, "unhealthy", error, usedForChat)) ?? updated;
  }
  return updated;
}

/** Retests key credentials through discovery and each discovered model endpoint. */
export async function testStoredKey(row: StoredKeyRow) {
  return refreshStoredKeyModels(row);
}
