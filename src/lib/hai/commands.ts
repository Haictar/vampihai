// Pure rules for what a chat message asks HAI to do. Shared by typed and spoken input.

const IMAGE_VERBS = "generate|create|make|draw|paint|design|render|produce|sketch|imagine|illustrate";
const IMAGE_NOUNS =
  "image|images|picture|pictures|pic|photo|photos|photograph|illustration|drawing|painting|logo|icon|wallpaper|poster|artwork|art|portrait|sketch|render|banner|thumbnail";

// "generate an image of…", "can you draw me a picture of…", "make a logo for…"
const IMAGE_REQUEST = new RegExp(
  `^(?:hey hai[,!]?\\s+)?(?:please\\s+)?(?:(?:can|could|would|will) you\\s+)?(?:please\\s+)?(?:${IMAGE_VERBS})\\s+(?:me\\s+|us\\s+)?(?:an?\\s+|the\\s+|some\\s+|one\\s+|\\d+\\s+)?(?:[\\w-]+\\s+){0,3}?(?:${IMAGE_NOUNS})\\b`,
  "i",
);
// "draw a cat", "paint a sunset" — these verbs mean a picture on their own.
const PICTURE_VERB_REQUEST = /^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?\S/i;
const IMAGE_COMMAND = /^\/(?:image|img|imagine)\s+\S/i;

// Questions about building image features in code are not picture requests.
const CODE_WORDS =
  /\b(?:html|css|react|component|function|code|upload|uploader|api|python|javascript|typescript|script|tag|element|button|endpoint|database|class|sql|program|app)\b/i;

/** True when the message asks HAI to produce a picture rather than a text answer. */
export function isImageRequest(text: string): boolean {
  const t = text.trim();
  if (IMAGE_COMMAND.test(t)) return true;
  if (CODE_WORDS.test(t)) return false;
  return IMAGE_REQUEST.test(t) || PICTURE_VERB_REQUEST.test(t);
}

/** Prompt sent to the image maker: the request without a leading /image command. */
export function imagePrompt(text: string): string {
  return text.trim().replace(/^\/(?:image|img|imagine)\s+/i, "");
}

export type VoiceCommand =
  | "new_chat"
  | "open_api_manager"
  | "open_settings"
  | "close_menu"
  | "open_menu"
  | "stop_assistant";

/** "stop", "stop listening", "that's all", "goodbye": ends the spoken conversation. */
export const STOP_PHRASE =
  /^(?:stop(?: listening| talking| it)?|be quiet|quiet|shut up|cancel|never ?mind|that'?s all|that is all|good ?bye|bye(?: bye)?)(?:\s+(?:hai|hi|high|ai))?$/;

const VOICE_COMMANDS: { command: VoiceCommand; pattern: RegExp }[] = [
  { command: "new_chat", pattern: /^(?:start\s+)?(?:a\s+)?(?:new (?:chat|conversation)|clear (?:the )?chat|start over)$/ },
  { command: "open_api_manager", pattern: /^(?:open|show)\s+(?:the\s+)?(?:api|a p i)(?:\s+key)?\s+manager$/ },
  { command: "open_settings", pattern: /^(?:open|show)\s+(?:the\s+)?settings$/ },
  { command: "close_menu", pattern: /^(?:close|hide)\s+(?:the\s+)?(?:menu|sidebar|side menu)$/ },
  { command: "open_menu", pattern: /^(?:open|show)\s+(?:the\s+)?(?:menu|sidebar|side menu)$/ },
  { command: "stop_assistant", pattern: STOP_PHRASE },
];

/** App actions a person can say out loud ("new chat", "open the API manager"). */
export function matchVoiceCommand(spoken: string): VoiceCommand | null {
  const t = spoken
    .toLowerCase()
    .replace(/^(?:hey\s+)?hai[,!]?\s+/, "")
    .replace(/^please\s+/, "")
    .replace(/[.!?,]+$/g, "")
    .trim();
  return VOICE_COMMANDS.find((c) => c.pattern.test(t))?.command ?? null;
}

export interface BrowserVoiceAction {
  url: string;
  /** Name shown on the "Open …" button, for example "Spotify". */
  label: string;
}

const SITE_LABELS: Record<string, string> = {
  youtube: "YouTube",
  github: "GitHub",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
  "google maps": "Google Maps",
  maps: "Google Maps",
  x: "X",
  twitter: "X",
};

function siteLabel(name: string): string {
  return SITE_LABELS[name] ?? name.replace(/\b\w/g, (c) => c.toUpperCase());
}

const KNOWN_SITES: Record<string, string> = {
  youtube: "https://www.youtube.com",
  google: "https://www.google.com",
  gmail: "https://mail.google.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  wikipedia: "https://www.wikipedia.org",
  github: "https://github.com",
  twitter: "https://x.com",
  x: "https://x.com",
  facebook: "https://www.facebook.com",
  instagram: "https://www.instagram.com",
  linkedin: "https://www.linkedin.com",
  reddit: "https://www.reddit.com",
  amazon: "https://www.amazon.com",
  netflix: "https://www.netflix.com",
  spotify: "https://open.spotify.com",
  whatsapp: "https://web.whatsapp.com",
};

function cleanSpoken(spoken: string): string {
  return spoken
    .toLowerCase()
    .replace(/^(?:hey\s+)?hai[,!]?\s+/, "")
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?/, "")
    .replace(/[.!?,]+$/g, "")
    .trim();
}

const YOUTUBE_SEARCH = "https://www.youtube.com/results?search_query=";
const SPOTIFY_SEARCH = "https://open.spotify.com/search/";

function mediaSearch(app: string, query: string): BrowserVoiceAction | null {
  const q = query.replace(/\s+(?:on it|there|for me|please)$/, "").trim();
  if (!q) return null;
  if (app === "spotify") return { url: `${SPOTIFY_SEARCH}${encodeURIComponent(q)}`, label: "Spotify" };
  if (app === "google") {
    return { url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, label: "Google" };
  }
  return { url: `${YOUTUBE_SEARCH}${encodeURIComponent(q)}`, label: "YouTube" };
}

/**
 * Requests the browser can do itself: "open YouTube", "go to example.com",
 * "search Google for cheap flights", "play lo-fi music on YouTube",
 * "open YouTube and play Khat", "play Khat on Spotify". Returns the page to open.
 * `typed` requests must name the site, so "play chess with me" typed stays a chat question.
 */
export function parseBrowserVoiceAction(
  spoken: string,
  opts: { typed?: boolean } = {},
): BrowserVoiceAction | null {
  const t = cleanSpoken(spoken);
  // "open YouTube and play Khat (on it)", "go to Spotify and search for lo-fi"
  const compound =
    /^(?:open|go to|launch|visit)\s+(youtube|spotify|google)\s+and\s+(?:then\s+)?(?:play|search(?: for)?|find|look up|put on|show(?: me)?)\s+(.+)$/.exec(
      t,
    );
  if (compound?.[1] && compound[2]) return mediaSearch(compound[1], compound[2]);
  // "play Khat on Spotify", "search Spotify for Khat"
  const spotify =
    /^search spotify for (.+)$/.exec(t) ??
    /^(?:play|search|find|look up|search for|put on) (.+?) on spotify$/.exec(t);
  if (spotify?.[1]) return mediaSearch("spotify", spotify[1]);
  const youtube =
    /^search youtube for (.+)$/.exec(t) ??
    /^(?:play|search|find|look up|search for|put on|show me) (.+?) on youtube$/.exec(t) ??
    (opts.typed ? null : /^play (.+)$/.exec(t));
  if (youtube?.[1]) return mediaSearch("youtube", youtube[1]);
  const search = opts.typed
    ? /^(?:google|search google for|search google|search (.+?) on google)\s*(.*)$/.exec(t)
    : /^(?:google|search (?:google |the web |online )?for|search google|look up)\s+(.+)$/.exec(t);
  const searchQuery = (search?.[1] || search?.[2] || "").trim();
  if (searchQuery) {
    return {
      url: `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`,
      label: "Google",
    };
  }
  const open = /^(?:open|go to|launch|visit|take me to)\s+(?:the\s+)?(.+?)(?:\s+website|\s+site)?$/.exec(t);
  if (!open?.[1]) return null;
  const target = open[1].trim();
  const known = KNOWN_SITES[target];
  if (known) return { url: known, label: siteLabel(target) };
  const domain = target.replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) return { url: `https://${domain}`, label: domain };
  return null;
}
