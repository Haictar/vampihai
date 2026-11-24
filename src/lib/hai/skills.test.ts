import { describe, expect, it } from "vitest";
import {
  decodeSkillModel,
  detectSkill,
  encodeSkillModel,
  parseSkillProfiles,
  rankSkillModels,
  type SkillModelRef,
} from "./skills";

const ref = (model: string, keyId = "k1"): SkillModelRef => ({ provider: "groq", model, keyId });

describe("skills", () => {
  it("sends picture requests to the image skill", () => {
    expect(detectSkill("a cat in space", true)).toBe("image");
  });

  it("sends code questions to the coding skill", () => {
    expect(detectSkill("Why does this python function throw an error?", false)).toBe("coding");
  });

  it("sends fact questions to the research skill", () => {
    expect(detectSkill("Explain the history of the Roman empire", false)).toBe("research");
  });

  it("sends small talk to the general skill", () => {
    expect(detectSkill("good morning!", false)).toBe("general");
  });

  it("round-trips a model reference", () => {
    const value = encodeSkillModel(ref("llama-3.3-70b"));
    expect(decodeSkillModel(value)).toEqual(ref("llama-3.3-70b"));
    expect(decodeSkillModel("not json")).toBeNull();
  });

  it("drops malformed and duplicate saved entries", () => {
    const good = encodeSkillModel(ref("m1"));
    const saved = JSON.stringify({ coding: [good, good, "junk", 5], mystery: [good] });
    expect(parseSkillProfiles(saved)).toEqual({ coding: [good], research: [], image: [], general: [] });
  });

  it("ranks coder models first for coding", () => {
    const ranked = rankSkillModels("coding", [ref("llama-3.1-8b-instant"), ref("qwen-2.5-coder-32b")]);
    expect(ranked[0]?.model).toBe("qwen-2.5-coder-32b");
  });
});
