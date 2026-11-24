import { useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Code2, ImageIcon, MessageCircle, Plus, X } from "lucide-react";
import {
  MAX_PINNED_MODELS,
  SKILL_PROFILES,
  encodeSkillModel,
  type SkillId,
  type SkillModelRef,
  type SkillProfileSettings,
} from "@/lib/hai/skills";

export interface SkillModelOption {
  model: SkillModelRef;
  label: string;
}

const SKILL_ICONS: Record<SkillId, typeof Code2> = {
  coding: Code2,
  research: BookOpen,
  image: ImageIcon,
  general: MessageCircle,
};

interface SkillManagerProps {
  profiles: SkillProfileSettings;
  models: Record<SkillId, SkillModelOption[]>;
  error?: string;
  onChange: (profiles: SkillProfileSettings) => void;
}

/** Lets a person pin the models HAI tries first for each kind of request. */
export function SkillManager({ profiles, models, error, onChange }: SkillManagerProps) {
  const [drafts, setDrafts] = useState<Partial<Record<SkillId, string>>>({});

  const update = (skill: SkillId, next: string[]) => onChange({ ...profiles, [skill]: next });
  const move = (skill: SkillId, index: number, by: -1 | 1) => {
    const next = [...profiles[skill]];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    update(skill, next);
  };

  return (
    <div className="skill-manager">
      <p className="skill-manager__intro">
        When the model picker is on <strong>Auto</strong>, HAI spots what you're asking for and
        tries your pinned models first, then the best other ones.
      </p>
      {error && (
        <p className="api-error" role="alert">
          {error}
        </p>
      )}
      {SKILL_PROFILES.map((skill) => {
        const Icon = SKILL_ICONS[skill.id];
        const options = models[skill.id];
        const labels = new Map(options.map((o) => [encodeSkillModel(o.model), o.label]));
        const pinned = profiles[skill.id];
        const addable = options.filter((o) => !pinned.includes(encodeSkillModel(o.model)));
        const draft = drafts[skill.id] ?? "";
        const canAdd = Boolean(draft) && pinned.length < MAX_PINNED_MODELS;
        return (
          <section key={skill.id} className="skill-profile" aria-label={`${skill.label} skill`}>
            <h3>
              <Icon aria-hidden="true" />
              {skill.label}
            </h3>
            <p className="skill-profile__note">{skill.description}</p>
            {pinned.length > 0 ? (
              <ol className="skill-profile__models">
                {pinned.map((value, index) => (
                  <li key={value}>
                    <span>
                      <small>{index + 1}</small>
                      {labels.get(value) ?? "Model no longer available"}
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => move(skill.id, index, -1)}
                        disabled={index === 0}
                        aria-label="Move up"
                      >
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(skill.id, index, 1)}
                        disabled={index === pinned.length - 1}
                        aria-label="Move down"
                      >
                        <ArrowDown aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          update(
                            skill.id,
                            pinned.filter((item) => item !== value),
                          )
                        }
                        aria-label="Remove"
                      >
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="skill-profile__empty">
                {options.length === 0
                  ? skill.id === "image"
                    ? "No picture models from your keys yet, so HAI uses its built-in image maker."
                    : "Add an API key with working chat models to choose models here."
                  : "Automatic: HAI picks the best model for this skill."}
              </p>
            )}
            {addable.length > 0 && (
              <div className="skill-profile__add">
                <select
                  value={draft}
                  aria-label={`Add a model to ${skill.label}`}
                  onChange={(event) => setDrafts({ ...drafts, [skill.id]: event.target.value })}
                >
                  <option value="">Pin a model…</option>
                  {addable.map((option) => {
                    const value = encodeSkillModel(option.model);
                    return (
                      <option key={value} value={value}>
                        {option.label}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  disabled={!canAdd}
                  aria-label={`Pin model to ${skill.label}`}
                  onClick={() => {
                    if (!canAdd) return;
                    update(skill.id, [...pinned, draft]);
                    setDrafts({ ...drafts, [skill.id]: "" });
                  }}
                >
                  <Plus aria-hidden="true" />
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
