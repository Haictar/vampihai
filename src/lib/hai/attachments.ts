// Turns files a person attaches in the chat into something every chat model can read:
// images become small JPEG data URLs, code/text files and zip contents become fenced text.
import { unzipSync } from "fflate";

export type Attachment =
  | { id: string; kind: "image"; name: string; dataUrl: string }
  | { id: string; kind: "file"; name: string; text: string; truncated: boolean }
  | {
      id: string;
      kind: "zip";
      name: string;
      files: { path: string; text: string }[];
      skipped: string[];
      truncated: boolean;
    };

/** Characters of file text sent with one message, across every attached file. */
export const MAX_ATTACHMENT_CHARS = 120_000;
export const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;

export class AttachmentError extends Error {}

const SKIPPED_PATHS = /(^|\/)(__MACOSX|\.git|node_modules|\.next|dist|build|\.cache|\.venv|venv|__pycache__)\//;
const SKIPPED_FILES = /(^|\/)(\.DS_Store|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Thumbs\.db)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|heic|avif|tiff?)$/i;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
  css: "css", scss: "scss", less: "less", json: "json", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", md: "markdown", sql: "sql", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
  dockerfile: "dockerfile", lua: "lua", r: "r", dart: "dart", scala: "scala", txt: "",
};

export function languageForFile(name: string): string {
  const base = name.split("/").pop()?.toLowerCase() ?? "";
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return LANGUAGE_BY_EXT[ext] ?? "";
}

/** A file is treated as text when its first bytes hold no NUL characters. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8000);
  for (const b of sample) if (b === 0) return true;
  return false;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
}

/** Wraps text in a fence longer than any backtick run inside it, so file contents can't break out. */
export function fence(text: string, language: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

/** Splits a zip into readable text files (up to the budget) and the names it had to leave out. */
export function readZip(bytes: Uint8Array, budget: number) {
  const skipped: string[] = [];
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.endsWith("/") || SKIPPED_PATHS.test(entry.name) || SKIPPED_FILES.test(entry.name)) return false;
      if (IMAGE_EXT.test(entry.name) || entry.originalSize > MAX_ZIP_ENTRY_BYTES) {
        skipped.push(entry.name);
        return false;
      }
      return true;
    },
  });
  const files: { path: string; text: string }[] = [];
  let used = 0;
  let truncated = false;
  for (const path of Object.keys(entries).sort()) {
    const data = entries[path]!;
    if (looksBinary(data)) {
      skipped.push(path);
      continue;
    }
    const text = decodeText(data);
    if (used + text.length > budget) {
      truncated = true;
      skipped.push(path);
      continue;
    }
    used += text.length;
    files.push({ path, text });
  }
  return { files, skipped, truncated, used };
}

/** Characters of text an attachment adds to the message. */
export function attachmentChars(a: Attachment): number {
  if (a.kind === "file") return a.text.length;
  if (a.kind === "zip") return a.files.reduce((n, f) => n + f.text.length, 0);
  return 0;
}

/** The full text the model receives: what the person typed plus every attached file. */
export function buildModelText(typed: string, attachments: Attachment[]): string {
  const parts = [typed.trim()];
  for (const a of attachments) {
    if (a.kind === "file") {
      parts.push(`Attached file \`${a.name}\`${a.truncated ? " (cut short, too long)" : ""}:\n${fence(a.text, languageForFile(a.name))}`);
    } else if (a.kind === "zip") {
      const body = a.files.map((f) => `File \`${f.path}\`:\n${fence(f.text, languageForFile(f.path))}`).join("\n\n");
      const left = a.skipped.length
        ? `\n\nNot included (binary, image or too large): ${a.skipped.slice(0, 40).join(", ")}${a.skipped.length > 40 ? ", …" : ""}`
        : "";
      parts.push(`Attached zip \`${a.name}\` with ${a.files.length} readable file${a.files.length === 1 ? "" : "s"}:\n\n${body}${left}`);
    }
  }
  const images = attachments.filter((a) => a.kind === "image").length;
  if (images && !parts[0]) parts[0] = images === 1 ? "Look at the attached image." : "Look at the attached images.";
  return parts.filter(Boolean).join("\n\n");
}

async function imageToDataUrl(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AttachmentError(`"${file.name}" is an image format this browser can't open. Try PNG, JPG or WebP.`);
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new AttachmentError("Could not prepare the image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.86);
}

/** Reads one attached file. `budget` is how many characters of text are still free in this message. */
export async function readAttachment(file: File, budget: number): Promise<Attachment> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (file.size > MAX_UPLOAD_BYTES) throw new AttachmentError(`"${file.name}" is larger than 30 MB.`);

  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
    return { id, kind: "image", name: file.name, dataUrl: await imageToDataUrl(file) };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
    let zip;
    try {
      zip = readZip(bytes, budget);
    } catch {
      throw new AttachmentError(`"${file.name}" isn't a zip file HAI can open.`);
    }
    if (zip.files.length === 0) {
      throw new AttachmentError(
        zip.truncated
          ? `"${file.name}" has more text than fits in one message. Remove other files or zip fewer files.`
          : `"${file.name}" has no text or code files HAI can read.`,
      );
    }
    return { id, kind: "zip", name: file.name, files: zip.files, skipped: zip.skipped, truncated: zip.truncated };
  }

  if (looksBinary(bytes)) {
    throw new AttachmentError(`"${file.name}" isn't a text, code, image or zip file, so HAI can't read it.`);
  }
  if (budget <= 0) throw new AttachmentError("This message already holds as much file text as fits.");
  const text = decodeText(bytes);
  return { id, kind: "file", name: file.name, text: text.slice(0, budget), truncated: text.length > budget };
}
