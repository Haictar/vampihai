// Web sources a provider cites for a reply. Pure, so it is unit-tested and safe in the browser.

export interface GroundingSource {
  title: string;
  url: string;
}

const MAX_SOURCES = 8;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only plain web links are shown; anything else (javascript:, data:, relative) is dropped. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function titleFor(url: string, title: unknown): string {
  if (typeof title === "string" && title.trim()) return title.trim().slice(0, 500);
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * Reads cited sources from an OpenAI-compatible chat response. Supports the two shapes providers
 * use: `message.annotations[].url_citation` and a top-level `citations` list (URLs or objects).
 */
export function extractSources(json: unknown): GroundingSource[] {
  const root = obj(json);
  if (!root) return [];
  const found = new Map<string, GroundingSource>();
  const add = (rawUrl: unknown, title?: unknown) => {
    const url = safeUrl(rawUrl);
    if (!url || found.has(url) || found.size >= MAX_SOURCES) return;
    found.set(url, { url, title: titleFor(url, title) });
  };

  const choices = Array.isArray(root["choices"]) ? root["choices"] : [];
  const message = obj(obj(choices[0])?.["message"]);
  const annotations = Array.isArray(message?.["annotations"]) ? message["annotations"] : [];
  for (const annotation of annotations) {
    const citation = obj(obj(annotation)?.["url_citation"]);
    if (citation) add(citation["url"], citation["title"]);
  }

  const citations = Array.isArray(root["citations"]) ? root["citations"] : [];
  for (const citation of citations) {
    if (typeof citation === "string") add(citation);
    else add(obj(citation)?.["url"], obj(citation)?.["title"]);
  }

  return [...found.values()];
}
