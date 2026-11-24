// Pure rules for the "Hello HAI" wake word and HAI's female voice. Browser-free so they can be tested.

// Speech recognisers write "HAI" many ways: hai, hi, high, hay, hey, AI, H.A.I.
const WAKE_PHRASE =
  /\b(?:hello|hallo|hullo|helo)\s*[,.!]?\s*(?:hai|hi|hii|high|hay|hey|hye|hie|hy|ai|a\.?\s?i\.?|h\.?\s?a\.?\s?i\.?)(?=$|[\s,.!?])[\s,.!?]*/i;

/**
 * Looks for "Hello HAI" in what the microphone heard. Returns null when it is not there,
 * otherwise whatever was said after it (empty when the person only said the wake word).
 */
export function findWakeWord(heard: string): { rest: string } | null {
  const match = WAKE_PHRASE.exec(heard);
  if (!match) return null;
  return { rest: heard.slice(match.index + match[0].length).trim() };
}

export interface VoiceLike {
  name: string;
  lang: string;
}

const FEMALE_NAMES =
  /female|woman|samantha|victoria|karen|moira|tessa|fiona|veena|lekha|zira|aria|jenny|michelle|emma|ava|allison|susan|serena|kate|hazel|libby|sonia|natasha|heera|neerja|swara|kalpana|priya|ananya|kajal|salli|joanna|kimberly|ivy|amy|olivia|nicky|catherine|linda|heather|eva|siri female/i;
const MALE_NAMES =
  /\bmale\b|\bman\b|david|mark|daniel|alex\b|fred|rishi|ravi|prabhat|hemant|madhur|george|guy|ryan|thomas|aaron|arthur|oliver|james|tom\b|matthew|brian|joey|justin|kevin|russell|eric|christopher|roger|steffan/i;

/**
 * Picks a female voice, preferring the person's language, then English.
 * Google's unnamed "Google US English" voice is female in Chrome.
 */
export function pickFemaleVoice<T extends VoiceLike>(voices: readonly T[], lang: string): T | null {
  const base = lang.toLowerCase().split("-")[0] ?? "en";
  const female = (v: T) =>
    (FEMALE_NAMES.test(v.name) && !/\bmale\b/i.test(v.name.replace(/female/gi, ""))) ||
    /^google (us|uk) english$/i.test(v.name) ||
    (/^google /i.test(v.name) && !MALE_NAMES.test(v.name));
  const notMale = (v: T) => !MALE_NAMES.test(v.name.replace(/female/gi, ""));
  const langScore = (v: T) => {
    const l = v.lang.toLowerCase().replace("_", "-");
    if (l === lang.toLowerCase()) return 3;
    if (l.startsWith(`${base}-`) || l === base) return 2;
    if (l.startsWith("en")) return 1;
    return 0;
  };
  const byLanguage = voices.filter((v) => langScore(v) > 0).sort((a, b) => langScore(b) - langScore(a));
  return byLanguage.find(female) ?? byLanguage.find(notMale) ?? null;
}
