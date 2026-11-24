import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  KEY_COLUMNS,
  callChatCompletion,
  createStoredKey,
  discoverProviderModels,
  loadSecrets,
  recordFailure,
  recordKeyResult,
  refreshStoredKeyModels,
  resolveBaseUrl,
  testStoredKey,
  testStoredModel,
  testStoredModels,
  type ChatTurn,
} from "./hai.server";
import { generateHaiImage, type HaiImageResult } from "./images.server";
import type { GroundingSource } from "./grounding";
import {
  MODEL_LIST_ADAPTERS,
  ModelDiscoveryError,
  isModelUnavailableError,
  type DiscoveredModel,
  readStoredModels,
} from "./discovery";
import {
  PROVIDER_IDS,
  getProvider,
  orderPreferredCandidates,
  orderRouteCandidates,
  validateCustomBaseUrl,
  type KeyStatus,
  type ProviderId,
} from "./providers";

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("api_keys")
      .select(KEY_COLUMNS)
      .order("created_at", { ascending: true });
    if (error) throw new Error("Could not load your API keys.");
    return data;
  });

const addSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  apiKey: z.string().trim().min(8, "That key looks too short.").max(1000),
  label: z.string().trim().max(40).optional(),
  baseUrl: z.string().trim().max(300).optional(),
});

/** Saves one encrypted key, discovers its catalog, and tests every chat-capable model. */
export const addApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => addSchema.parse(input))
  .handler(async ({ data, context }) => {
    let baseUrl: string | null = null;
    if (data.provider === "custom") {
      const checked = validateCustomBaseUrl(data.baseUrl ?? "");
      if (!checked.ok) throw new Error(checked.error);
      baseUrl = checked.url;
    }

    const { data: existingKeys, error: existingError } = await context.supabase
      .from("api_keys")
      .select(KEY_COLUMNS)
      .order("created_at", { ascending: true });
    if (existingError) throw new Error("Could not check your saved API keys.");
    const existingSecrets = await loadSecrets((existingKeys ?? []).map((key) => key.id));
    const duplicate = existingKeys?.find(
      (key) =>
        key.provider === data.provider &&
        key.base_url === baseUrl &&
        existingSecrets.get(key.id) === data.apiKey,
    );
    if (duplicate) return duplicate;

    let models: DiscoveredModel[] = [];
    let modelsError: string | null = null;
    let keyStatus: KeyStatus = "untested";
    try {
      models = await discoverProviderModels(data.provider, data.apiKey, baseUrl);
      if (MODEL_LIST_ADAPTERS[data.provider].listVerifiesKey) keyStatus = "healthy";
    } catch (err) {
      modelsError = err instanceof ModelDiscoveryError ? err.message : "Model discovery failed.";
      if (err instanceof ModelDiscoveryError) {
        if (err.kind === "auth") keyStatus = "unhealthy";
        else if (err.kind === "no_models" && MODEL_LIST_ADAPTERS[data.provider].listVerifiesKey) {
          keyStatus = "healthy";
        }
      }
    }
    const row = await createStoredKey({
      userId: context.userId,
      provider: data.provider,
      status: keyStatus,
      lastError: keyStatus === "unhealthy" ? modelsError : null,
      modelsError,
      models,
      label: data.label ?? "",
      baseUrl,
      apiKey: data.apiKey,
    });
    if (modelsError || models.length === 0) return row;
    return (
      (await testStoredModels(
        row,
        data.apiKey,
        MODEL_LIST_ADAPTERS[data.provider].listVerifiesKey,
      )) ?? row
    );
  });

const idSchema = z.object({ id: z.string().uuid() });

export const testApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => idSchema.parse(input))
  .handler(async ({ data, context }) => {
    // RLS-scoped lookup proves the caller owns this key.
    const { data: row } = await context.supabase
      .from("api_keys")
      .select(KEY_COLUMNS)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Key not found.");
    return (await testStoredKey(row)) ?? row;
  });

export const refreshApiKeyModels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => idSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("api_keys")
      .select(KEY_COLUMNS)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Key not found.");
    return (await refreshStoredKeyModels(row)) ?? row;
  });

const modelTestSchema = z.object({
  id: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
});

export const testApiKeyModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => modelTestSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("api_keys")
      .select(KEY_COLUMNS)
      .eq("id", data.id)
      .maybeSingle();
    if (!row) throw new Error("Key not found.");
    return (await testStoredModel(row, data.model)) ?? row;
  });

export const removeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => idSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: removed, error } = await context.supabase
      .from("api_keys")
      .delete()
      .eq("id", data.id)
      .select("id");
    if (error) throw new Error("Could not remove the key.");
    if (!removed || removed.length === 0) throw new Error("Key not found.");
    return { id: data.id };
  });

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
/** Typed text plus attached file contents for one turn. */
const MAX_TURN_CHARS = 130_000;

const chatPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(MAX_TURN_CHARS) }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().max(8_000_000).regex(IMAGE_DATA_URL, "Unsupported image."),
    }),
  }),
]);

const modelRefSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1).max(200),
  keyId: z.string().uuid(),
});

const chatSchema = z.object({
  spoken: z.boolean().optional(),
  /** Skill order on "Auto": models the person prefers for this kind of request. */
  preferredModels: z.array(modelRefSchema).max(12).optional(),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1).max(200),
  keyId: z.string().uuid(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([
          z.string().trim().min(1).max(MAX_TURN_CHARS),
          z.array(chatPartSchema).min(1).max(5),
        ]),
      }),
    )
    .min(1)
    .max(20),
});

const SYSTEM_PROMPT =
  "You are HAI, a helpful AI assistant inside a cosmic voice-orb app. " +
  "Format answers in Markdown. Always put code in fenced code blocks with a language tag (for example ```python). " +
  "When the person attaches files or a zip, their contents appear as fenced blocks labelled with the file name; " +
  "when asked to edit them, return each changed file in full in its own code block, with the file name on the line above. " +
  "Answer exactly what was asked and nothing more: no greeting, no restating the question, " +
  "no follow-up offers, no extra tips or suggestions the person did not ask for. Keep answers short and direct. " +
  "HAI can open websites and apps in a new browser tab. When the person asks you to open a website or app, " +
  "or to play, watch, listen to or search for something on one, reply with only [[open:URL]] using the best https URL " +
  "(for songs and videos use a search page, for example https://www.youtube.com/results?search_query=khat or " +
  "https://open.spotify.com/search/khat). Never say you cannot open apps, websites or videos.";

/** Added when the person spoke their message: the reply is read aloud. */
const SPOKEN_PROMPT =
  "The person asked this by voice and your reply will be read aloud. " +
  "Reply in one to three short spoken sentences of plain text: no Markdown, no lists, no code, no links, no emoji. " +
  "Only include code if they clearly asked for code, and then keep the spoken sentence separate from the code block.";

export interface HaiAttempt {
  provider: string;
  model: string;
  error: string;
}

export type HaiChatResult =
  | {
      ok: true;
      text: string;
      provider: ProviderId;
      providerLabel: string;
      model: string;
      /** The model the person picked; differs from `model` when HAI switched. */
      requestedModel: string;
      keyLabel: string;
      attempts: HaiAttempt[];
      /** Web pages the provider cited for this reply, when it cites any. */
      sources?: GroundingSource[];
    }
  | { ok: false; reason: "no_keys" | "all_failed"; message: string; attempts: HaiAttempt[] };

export const haiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => chatSchema.parse(input))
  .handler(async ({ data, context }): Promise<HaiChatResult> => {
    const { data: keys, error } = await context.supabase.from("api_keys").select(KEY_COLUMNS);
    if (error) throw new Error("Could not load your API keys.");
    if (!keys || keys.length === 0) {
      return {
        ok: false,
        reason: "no_keys",
        message: "Add an API key in the API Manager to start chatting.",
        attempts: [],
      };
    }

    const attempts: HaiAttempt[] = [];
    const routable = keys.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status as KeyStatus,
      created_at: row.created_at,
      models: readStoredModels(row.models),
      row,
    }));
    // Chosen model first, then the next best available model if it fails. On "Auto" the
    // Skill order for this request goes first.
    const routed = orderRouteCandidates(routable, {
      provider: data.provider,
      model: data.model,
      keyId: data.keyId,
    });
    const candidates = data.preferredModels?.length
      ? orderPreferredCandidates(routable, data.preferredModels, routed)
      : routed;
    const secrets = await loadSecrets([...new Set(candidates.map((c) => c.key.id))]);
    const messages: ChatTurn[] = [
      { role: "system", content: data.spoken ? `${SYSTEM_PROMPT} ${SPOKEN_PROMPT}` : SYSTEM_PROMPT },
      ...data.messages,
    ];
    const hasImages = data.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((part) => part.type === "image_url"),
    );
    const totalChars = data.messages.reduce(
      (n, m) =>
        n +
        (typeof m.content === "string"
          ? m.content.length
          : m.content.reduce((k, part) => k + (part.type === "text" ? part.text.length : 0), 0)),
      0,
    );
    // A key the provider rejected is skipped for the rest of this message.
    const rejectedKeys = new Set<string>();

    for (const { key, model } of candidates) {
      if (rejectedKeys.has(key.id)) continue;
      const provider = getProvider(key.provider as ProviderId);
      const apiKey = secrets.get(key.id);
      if (!apiKey) {
        attempts.push({ provider: provider.label, model, error: "Stored key could not be read" });
        await recordKeyResult(key.id, "unhealthy", "Stored key could not be read", true);
        rejectedKeys.add(key.id);
        continue;
      }
      const result = await callChatCompletion({
        baseUrl: resolveBaseUrl(provider.id, key.row.base_url),
        apiKey,
        model,
        messages,
        timeoutMs: 45000,
      });
      if (result.ok && result.text) {
        await recordKeyResult(key.id, "healthy", null, true);
        return {
          ok: true,
          text: result.text,
          provider: provider.id,
          providerLabel: provider.label,
          model,
          requestedModel: data.model,
          keyLabel: key.row.label,
          attempts,
          ...(result.sources.length ? { sources: result.sources } : {}),
        };
      }
      if (result.ok) {
        attempts.push({
          provider: provider.label,
          model,
          error: "Provider returned an empty reply",
        });
        await recordFailure(key.row, model, 502, "Provider returned an empty reply", true);
        continue;
      }
      // A model that can't read images, or a request too big for its context, says nothing about the
      // model's health: move on to the next candidate without marking anything unhealthy.
      if ((hasImages || totalChars > 20_000) && [400, 413, 422].includes(result.status)) {
        const why = hasImages
          ? "this model may not read images"
          : "the attached text may be too long for this model";
        attempts.push({ provider: provider.label, model, error: `${result.error} (${why})` });
        continue;
      }
      attempts.push({ provider: provider.label, model, error: result.error });
      await recordFailure(key.row, model, result.status, result.error, true);
      if (
        (result.status === 401 || result.status === 403) &&
        !isModelUnavailableError(result.status, result.error)
      ) {
        rejectedKeys.add(key.id);
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        reason: "all_failed",
        message:
          "No available chat model right now. Test your keys or refresh their model lists in the API Manager.",
        attempts,
      };
    }

    return {
      ok: false,
      reason: "all_failed",
      message: `Every model HAI tried failed (${attempts.map((a) => `${a.provider} · ${a.model}`).join(", then ")}). Check the API Manager for details.`,
      attempts,
    };
  });

const imageSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  images: z
    .array(z.string().max(8_000_000).regex(IMAGE_DATA_URL, "Unsupported image."))
    .max(4)
    .optional(),
});

/** Creates a picture with the built-in image maker; attached pictures are edited instead. */
export const haiImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => imageSchema.parse(input))
  .handler(async ({ data }): Promise<HaiImageResult> =>
    generateHaiImage(data.prompt, data.images ?? []),
  );
