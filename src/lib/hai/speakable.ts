/** Longest stretch read aloud; longer replies stop at the last full sentence before it. */
export const MAX_SPOKEN_CHARS = 320;

/** Said instead of silence when a reply is nothing but code. */
export const CODE_ONLY_SPEECH = "The code is on screen.";

// Inline code that is clearly code (symbols, calls, paths) is skipped; a plain word is kept.
const CODE_LIKE = /[(){}[\];=<>\\/$@#&|+*^%]|->|=>|\.\w|_\w|::/;

/**
 * Text that reads well aloud: only the spoken answer. Code blocks, inline code,
 * tables, links, Markdown symbols and emoji are left out, and long replies are
 * cut at a sentence end so HAI never reads on and on.
 */
export function speakableText(markdown: string, maxChars = MAX_SPOKEN_CHARS): string {
  const hadCode = /(`{3,}|~{3,})/.test(markdown);
  const prose = markdown
    // Fenced code blocks, including one the model never closed.
    .replace(/(`{3,}|~{3,})[\s\S]*?(\1|$)/g, " ")
    // Indented code blocks and table rows.
    .replace(/^(?: {4}|\t).*$/gm, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]+)`/g, (_, code: string) => (CODE_LIKE.test(code) ? " " : code))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    // List markers and numbering at line starts.
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/[#*_>|~`]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();

  if (!prose) return hadCode ? CODE_ONLY_SPEECH : "";
  return limitToSentences(prose, maxChars);
}

function limitToSentences(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > maxChars) break;
    out += sentence;
  }
  if (out.trim()) return out.trim();
  // First sentence alone is too long: cut at a word boundary.
  const cut = text.slice(0, maxChars);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim()}.`;
}
