/**
 * Opens a website or app in a new browser tab. Never navigates the HAI tab itself: when the
 * browser blocks the new tab (voice has no click, so pop-up blockers often step in) it returns
 * false and the caller shows a button the person can tap instead.
 */
export function openInNewTab(
  url: string,
  open: (url: string, target: string) => Window | null,
): boolean {
  const opened = open(url, "_blank");
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // Some browsers don't allow changing this; the tab is open either way.
  }
  return true;
}

const HOST_LABELS: Record<string, string> = {
  "youtube.com": "YouTube",
  "m.youtube.com": "YouTube",
  "music.youtube.com": "YouTube Music",
  "open.spotify.com": "Spotify",
  "spotify.com": "Spotify",
  "google.com": "Google",
  "maps.google.com": "Google Maps",
  "mail.google.com": "Gmail",
  "github.com": "GitHub",
  "x.com": "X",
  "web.whatsapp.com": "WhatsApp",
  "linkedin.com": "LinkedIn",
};

/**
 * The AI asks HAI to open a page by replying `[[open:https://…]]`. Returns that page and a
 * readable name, or null when the reply has no (safe http/https) open request.
 */
export function extractOpenAction(reply: string): { url: string; label: string } | null {
  const match = /\[\[open:\s*(https?:\/\/[^\s\]]+)\s*\]\]/i.exec(reply);
  if (!match?.[1]) return null;
  let parsed: URL;
  try {
    parsed = new URL(match[1]);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.replace(/^www\./, "");
  const label = HOST_LABELS[host] ?? host;
  return { url: parsed.toString(), label };
}
