// Client-safe provider catalog and pure routing rules for the HAI API Manager.
// Cloud providers only: local runtimes (Ollama, localhost, private networks) are rejected.

export const PROVIDER_IDS = ["gemini", "groq", "nvidia", "cohere", "custom"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type KeyStatus = "healthy" | "unhealthy" | "untested";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base URL; null for custom (user supplies it). */
  baseUrl: string | null;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "gemini",
    label: "Google AI Studio (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  {
    id: "cohere",
    label: "Cohere",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseUrl: null,
  },
];

export function getProvider(id: ProviderId): ProviderInfo {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/**
 * A key can serve chat only when it has a selected model that is still in its discovered list.
 * Keys whose model was retired are skipped — never silently switched to another model.
 */
export function isKeyRoutable(key: { model: string | null; models: readonly { id: string }[] }): boolean {
  return !!key.model && key.models.some((m) => m.id === key.model);
}

const STATUS_RANK: Record<KeyStatus, number> = { healthy: 0, untested: 1, unhealthy: 2 };

/**
 * Failover order: start with the best key (healthy > not tested > unhealthy, oldest first),
 * try the remaining keys of that same provider, then move on to the next provider.
 */
export function orderKeysForFailover<
  T extends { provider: string; status: KeyStatus; created_at: string },
>(keys: readonly T[]): T[] {
  const sorted = [...keys].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.created_at.localeCompare(b.created_at),
  );
  const providerOrder: string[] = [];
  for (const key of sorted) {
    if (!providerOrder.includes(key.provider)) providerOrder.push(key.provider);
  }
  return providerOrder.flatMap((provider) => sorted.filter((key) => key.provider === provider));
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes("ollama")
  ) {
    return true;
  }
  if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return host.includes(":");
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

/** Validates a custom OpenAI-compatible endpoint: public HTTPS cloud hosts only. */
export function validateCustomBaseUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL, e.g. https://api.example.com/v1" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The endpoint must use https://" };
  if (url.username || url.password) return { ok: false, error: "Remove credentials from the URL." };
  if (isPrivateHost(url.hostname) || url.port === "11434") {
    return { ok: false, error: "Only cloud endpoints are allowed (no Ollama or local models)." };
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return { ok: true, url: `${url.origin}${path}` };
}

/** Most model attempts one chat message makes before giving up. */
export const MAX_ROUTE_ATTEMPTS = 6;

/**
 * Rough capability score from a model id, used to pick the best fallback model.
 * Bigger models, higher tiers (pro, large, ultra) and newer versions score higher;
 * small tiers (mini, lite, nano) score lower.
 */
export function modelQualityScore(id: string): number {
  const s = id.toLowerCase();
  let score = 0;
  const size = s.match(/(\d+(?:\.\d+)?)b(?![a-z])/);
  if (size) score += Math.min(Math.sqrt(Number(size[1])) * 2, 45);
  const version = s.match(/(?:^|[-_/a-z])(\d+(?:\.\d+)?)(?![\d.]*b(?![a-z]))/);
  if (version) score += Math.min(Number(version[1]) * 3, 30);
  if (/(ultra|opus)/.test(s)) score += 40;
  else if (/(^|[-_/])(pro|large|plus|max|command-a)([-_/]|$)|r-plus/.test(s)) score += 30;
  else if (/(^|[-_/])(medium|versatile)([-_/]|$)/.test(s)) score += 8;
  if (/flash/.test(s)) score += 6;
  if (/(^|[-_/])(mini|small|lite|nano|tiny|instant)([-_/]|$)/.test(s)) score -= 12;
  if (/(guard|embed|whisper|tts|rerank|moderation)/.test(s)) score -= 60;
  return score;
}

export interface RouteKey {
  id: string;
  provider: string;
  status: KeyStatus;
  created_at: string;
  models: readonly { id: string; health: string }[];
}

/**
 * Chat routing order. First the chosen model (on the chosen key, then on the same provider's
 * other keys); if that fails, the remaining available models from every working key, best
 * model first. Unhealthy keys and unavailable models are never tried.
 */
export function orderRouteCandidates<K extends RouteKey>(
  keys: readonly K[],
  selected: { provider: string; model: string; keyId?: string } | null,
  max: number = MAX_ROUTE_ATTEMPTS,
): { key: K; model: string }[] {
  const usable = orderKeysForFailover(keys.filter((k) => k.status !== "unhealthy"));
  const offers = (key: K, model: string) =>
    key.models.some((m) => m.id === model && m.health === "available");
  const out: { key: K; model: string }[] = [];
  const seen = new Set<string>();
  const push = (key: K, model: string) => {
    const id = `${key.id}:${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, model });
  };

  if (selected) {
    const sameProvider = usable.filter(
      (k) => k.provider === selected.provider && offers(k, selected.model),
    );
    const chosen = sameProvider.find((k) => k.id === selected.keyId);
    if (chosen) push(chosen, selected.model);
    for (const key of sameProvider) push(key, selected.model);
  }

  const tried = new Set(out.map((c) => `${c.key.provider}:${c.model}`));
  const rest = new Map<string, { key: K; model: string; score: number; rank: number }>();
  usable.forEach((key, rank) => {
    for (const m of key.models) {
      if (m.health !== "available") continue;
      const identity = `${key.provider}:${m.id}`;
      if (tried.has(identity) || rest.has(identity)) continue;
      rest.set(identity, { key, model: m.id, score: modelQualityScore(m.id), rank });
    }
  });
  [...rest.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        STATUS_RANK[a.key.status] - STATUS_RANK[b.key.status] ||
        a.rank - b.rank,
    )
    .forEach((c) => push(c.key, c.model));

  return out.slice(0, max);
}

/**
 * Skill routing on "Auto": the person's preferred models (in their order) first, as long as the
 * key still works and the model is still available, then HAI's usual order. Never tries the
 * same model on the same key twice and stops at `max` attempts.
 */
export function orderPreferredCandidates<K extends RouteKey>(
  keys: readonly K[],
  preferred: readonly { provider: string; model: string; keyId: string }[],
  fallback: readonly { key: K; model: string }[],
  max: number = MAX_ROUTE_ATTEMPTS,
): { key: K; model: string }[] {
  const out: { key: K; model: string }[] = [];
  const seen = new Set<string>();
  const push = (key: K, model: string) => {
    const id = `${key.id}:${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, model });
  };
  for (const ref of preferred) {
    const key = keys.find((k) => k.id === ref.keyId && k.provider === ref.provider);
    if (!key || key.status === "unhealthy") continue;
    if (!key.models.some((m) => m.id === ref.model && m.health === "available")) continue;
    push(key, ref.model);
  }
  for (const candidate of fallback) push(candidate.key, candidate.model);
  return out.slice(0, max);
}
