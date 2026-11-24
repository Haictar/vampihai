// Skills: which models HAI prefers for a kind of request (coding, research, pictures, everything
// else). Pure and browser-safe, so the rules are unit-tested.
import { modelQualityScore, type ProviderId } from "./providers";

export type SkillId = "coding" | "research" | "image" | "general";

export interface SkillProfile {
  id: SkillId;
  label: string;
  description: string;
}

export const SKILL_PROFILES: readonly SkillProfile[] = [
  { id: "coding", label: "Coding", description: "Writing, fixing and explaining code." },
  { id: "research", label: "Research", description: "Facts, explanations and comparisons." },
  { id: "image", label: "Images", description: "Making and editing pictures." },
  { id: "general", label: "General", description: "Everything else." },
];

/** One model on one saved key. */
export interface SkillModelRef {
  provider: ProviderId;
  model: string;
  keyId: string;
}

/** Per skill, the person's own model order (encoded refs), tried before HAI's automatic order. */
export type SkillProfileSettings = Record<SkillId, string[]>;

export const DEFAULT_SKILL_PROFILES: SkillProfileSettings = {
  coding: [],
  research: [],
  image: [],
  general: [],
};

/** Most models a person can pin to one skill. */
export const MAX_PINNED_MODELS = 8;

export function encodeSkillModel(ref: SkillModelRef): string {
  return JSON.stringify([ref.provider, ref.model, ref.keyId]);
}

export function decodeSkillModel(value: string): SkillModelRef | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed.every((part) => typeof part === "string" && part.length > 0)
    ) {
      const [provider, model, keyId] = parsed as [string, string, string];
      return { provider: provider as ProviderId, model, keyId };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Reads saved settings; unknown skills and malformed entries are dropped. Throws on unreadable JSON. */
export function parseSkillProfiles(raw: string): SkillProfileSettings {
  const parsed: unknown = JSON.parse(raw);
  const source =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const out: SkillProfileSettings = { coding: [], research: [], image: [], general: [] };
  for (const { id } of SKILL_PROFILES) {
    const list = source[id];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const value of list) {
      if (typeof value !== "string" || !decodeSkillModel(value) || seen.has(value)) continue;
      seen.add(value);
      out[id].push(value);
      if (out[id].length >= MAX_PINNED_MODELS) break;
    }
  }
  return out;
}

const CODING_REQUEST =
  /```|\b(?:code|coding|function|bug|debug|error|stack ?trace|compile|refactor|regex|sql|api|script|typescript|javascript|python|java|rust|golang|c\+\+|c#|html|css|react|component|class|variable|unit test|terminal|bash|git)\b/i;
const RESEARCH_REQUEST =
  /\b(?:research|explain|why|how does|what is|what are|who (?:is|was)|when (?:did|was)|compare|difference between|history of|summari[sz]e|sources?|evidence|study|studies|statistics|facts?|latest|news)\b/i;

/** Picks the skill for a message. Picture requests are decided by the caller. */
export function detectSkill(text: string, wantsImage: boolean): SkillId {
  if (wantsImage) return "image";
  if (CODING_REQUEST.test(text)) return "coding";
  if (RESEARCH_REQUEST.test(text)) return "research";
  return "general";
}

const SKILL_HINTS: Record<SkillId, RegExp | null> = {
  coding: /(cod(?:e|er|estral|ing)|devstral|starcoder|deepseek|qwen.*coder|kimi|gpt-oss)/i,
  research: /(sonar|research|command-r|command-a|(^|[-_/])pro([-_/]|$)|thinking|reason|r1)/i,
  image: null,
  general: null,
};

/** HAI's automatic order for a skill: models suited to the skill first, then by overall quality. */
export function rankSkillModels(skill: SkillId, models: readonly SkillModelRef[]): SkillModelRef[] {
  const hint = SKILL_HINTS[skill];
  const unique = [...new Map(models.map((m) => [encodeSkillModel(m), m])).values()];
  return unique
    .map((model, index) => ({
      model,
      index,
      score: modelQualityScore(model.model) + (hint && hint.test(model.model) ? 25 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.model);
}
