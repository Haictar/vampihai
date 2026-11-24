import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Download,
  FileArchive,
  FileText,
  History,
  ImagePlus,
  KeyRound,
  LogOut,
  MessageCircle,
  Mic,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Settings,
  Sparkles,
  Square,
  Smartphone,
  Monitor,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { OrbController, OrbState } from "orbloom";
import { CosmicDustScene } from "@/components/cosmic/CosmicDustScene";
import { RadiationField } from "@/components/cosmic/RadiationField";
import { VoiceOrb } from "@/components/cosmic/orb/VoiceOrb";
import { ApiManager } from "@/components/cosmic/ApiManager";
import { GoogleSignInButton } from "@/components/cosmic/GoogleSignInButton";
import { SkillManager, type SkillModelOption } from "@/components/cosmic/SkillManager";
import { useAuthUser } from "@/hooks/use-auth-user";
import { useIsMobile } from "@/hooks/use-mobile";
import { ChatMarkdown } from "@/components/cosmic/ChatMarkdown";
import { useSpeechInput } from "@/hooks/use-speech-input";
import { useWakeWord } from "@/hooks/use-wake-word";
import { speakableText } from "@/lib/hai/speakable";
import { pickFemaleVoice } from "@/lib/hai/voice";
import { haiChat, haiImage, listApiKeys } from "@/lib/hai/hai.functions";
import {
  deleteChatConversation,
  listChatConversations,
  loadChatConversation,
  saveChatMessage,
} from "@/lib/hai/chat-history.functions";
import { readStoredModels } from "@/lib/hai/discovery";
import { getProvider, modelQualityScore, type ProviderId } from "@/lib/hai/providers";
import {
  imagePrompt,
  isImageRequest,
  matchVoiceCommand,
  parseBrowserVoiceAction,
} from "@/lib/hai/commands";
import {
  AttachmentError,
  MAX_ATTACHMENT_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  attachmentChars,
  buildModelText,
  readAttachment,
  type Attachment,
} from "@/lib/hai/attachments";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import type { GroundingSource } from "@/lib/hai/grounding";
import {
  DEFAULT_SKILL_PROFILES,
  SKILL_PROFILES,
  decodeSkillModel,
  detectSkill,
  encodeSkillModel,
  parseSkillProfiles,
  rankSkillModels,
  type SkillId,
  type SkillModelRef,
  type SkillProfileSettings,
} from "@/lib/hai/skills";

type ChatMessage = {
  id: number | string;
  role: "assistant" | "user";
  /** What is shown in the bubble. */
  text: string;
  /** What the model receives for this turn when it differs from `text` (attached file contents). */
  modelText?: string;
  /** Attached pictures (user) as data URLs. */
  images?: string[];
  /** Names of attached files and zips (user), shown as chips. */
  files?: { name: string; kind: "file" | "zip" }[];
  /** Picture made by the image maker (assistant). */
  image?: string;
  imagePrompt?: string;
  /** Provider and model that produced an assistant reply. */
  meta?: string;
  sources?: GroundingSource[];
  pending?: boolean;
  /** Local notices (sign-in prompts, errors) are not sent back to the model. */
  local?: boolean;
};

type ChatTurnInput = {
  role: "user" | "assistant";
  content:
    string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
};

const MAX_HISTORY_CHARS = 240_000;

function turnChars(turn: ChatTurnInput): number {
  return typeof turn.content === "string"
    ? turn.content.length
    : turn.content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0);
}

/** Recent conversation for the model; pictures are only re-sent with the newest message. */
function buildTurns(history: ChatMessage[]): ChatTurnInput[] {
  const recent = history
    .filter((m, index) => !m.pending && !m.local && !(index === 0 && m.role === "assistant"))
    .slice(-12);
  const turns = recent.map((m, index): ChatTurnInput => {
    const text =
      m.role === "assistant" && m.image
        ? `[I created an image for: ${m.imagePrompt ?? "the request"}]`
        : (m.modelText ?? m.text);
    if (m.role === "user" && m.images?.length) {
      if (index === recent.length - 1) {
        return {
          role: "user",
          content: [
            { type: "text", text: text || "Look at the attached image." },
            ...m.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ],
        };
      }
      return {
        role: "user",
        content:
          `${text}\n\n(${m.images.length} image${m.images.length > 1 ? "s were" : " was"} attached here.)`.trim(),
      };
    }
    return { role: m.role, content: text.slice(0, 130_000) };
  });
  let total = turns.reduce((n, t) => n + turnChars(t), 0);
  while (turns.length > 1 && total > MAX_HISTORY_CHARS) total -= turnChars(turns.shift()!);
  return turns;
}

type MenuView = "nav" | "settings" | "api" | "skills";

function displayName(user: { user_metadata?: Record<string, unknown> | null }): string | undefined {
  const meta = user.user_metadata ?? {};
  const name = meta["full_name"] ?? meta["name"];
  return typeof name === "string" && name.trim() ? name : undefined;
}

/** Model picker value that lets HAI choose the best available model. */
const AUTO_MODEL = "auto";

/** Remembers whether "Hello HAI" listening is switched on in this browser. */
const WAKE_WORD_STORAGE_KEY = "hai-wake-word";
const SKILL_PROFILES_STORAGE_KEY = "hai-skill-profiles-v1";

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 1,
    role: "assistant",
    text: "Ready when you are.",
  },
];

export function CosmicApp() {
  const orbRef = useRef<OrbController | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState("");
  const [imageMode, setImageMode] = useState(false);
  const [speakingId, setSpeakingId] = useState<number | string | null>(null);
  const speakingIdRef = useRef<number | string | null>(null);
  const draftBeforeVoiceRef = useRef("");
  const [wakeEnabled, setWakeEnabled] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const conversationActiveRef = useRef(false);
  const [voiceName, setVoiceName] = useState("");
  const femaleVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const [skillProfiles, setSkillProfiles] = useState<SkillProfileSettings>(DEFAULT_SKILL_PROFILES);
  const [skillStorageError, setSkillStorageError] = useState("");
  const [skillProfilesReady, setSkillProfilesReady] = useState(false);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [isOpeningConversation, setIsOpeningConversation] = useState(false);
  const historyUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    setWakeEnabled(window.localStorage.getItem(WAKE_WORD_STORAGE_KEY) !== "off");
    const synth = window.speechSynthesis;
    if (!synth) return;
    const loadVoices = () => {
      const voice = pickFemaleVoice(synth.getVoices(), navigator.language || "en-US");
      femaleVoiceRef.current = voice;
      setVoiceName(voice?.name ?? "");
    };
    loadVoices();
    synth.addEventListener("voiceschanged", loadVoices);
    return () => synth.removeEventListener("voiceschanged", loadVoices);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SKILL_PROFILES_STORAGE_KEY);
      if (saved) setSkillProfiles(parseSkillProfiles(saved));
    } catch {
      setSkillStorageError("Could not read saved Skill settings. Review and save them again.");
    } finally {
      setSkillProfilesReady(true);
    }
  }, []);

  useEffect(() => {
    if (!skillProfilesReady || skillStorageError) return;
    try {
      window.localStorage.setItem(SKILL_PROFILES_STORAGE_KEY, JSON.stringify(skillProfiles));
    } catch {
      setSkillStorageError("Could not save Skill settings in this browser.");
    }
  }, [skillProfiles, skillProfilesReady, skillStorageError]);

  // The message box grows with the typed text instead of scrolling sideways on one line.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [chatDraft]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);

  // Keep the newest message in view now that the chat fills the screen.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatMessages]);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();
  const [mobileMode, setMobileMode] = useState(false);
  const effectiveMobile = isMobile || mobileMode;
  const [menuView, setMenuView] = useState<MenuView>("nav");
  const [authError, setAuthError] = useState("");
  const { user } = useAuthUser();
  const queryClient = useQueryClient();
  const chat = useServerFn(haiChat);
  const makeImage = useServerFn(haiImage);
  const listKeys = useServerFn(listApiKeys);
  const listConversations = useServerFn(listChatConversations);
  const loadConversation = useServerFn(loadChatConversation);
  const saveMessage = useServerFn(saveChatMessage);
  const deleteConversation = useServerFn(deleteChatConversation);
  const persistentUserId = user && !user.is_anonymous ? user.id : null;
  const isPersistentUser = Boolean(persistentUserId);
  const [selectedModel, setSelectedModel] = useState(AUTO_MODEL);
  const apiKeys = useQuery({
    queryKey: ["hai-keys", user?.id],
    queryFn: () => listKeys(),
    enabled: Boolean(user),
  });
  const historyQuery = useInfiniteQuery({
    queryKey: ["hai-conversations", user?.id],
    queryFn: ({ pageParam }) => listConversations({ data: { offset: pageParam, limit: 30 } }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextOffset : undefined),
    enabled: isPersistentUser,
  });
  const savedConversations = historyQuery.data?.pages.flatMap((page) => page.items) ?? [];

  useEffect(() => {
    const nextUserId = persistentUserId;
    if (historyUserIdRef.current === nextUserId) return;
    historyUserIdRef.current = nextUserId;
    setCurrentConversationId(null);
    setChatMessages(INITIAL_MESSAGES);
    setHistoryError("");
  }, [persistentUserId]);
  const uniqueChatModels = useMemo(() => {
    const chatModels = (apiKeys.data ?? []).flatMap((key) =>
      key.status === "unhealthy"
        ? []
        : readStoredModels(key.models)
            .filter((model) => model.kind === "chat" && model.health === "available")
            .map((model) => ({
              ...model,
              provider: key.provider as ProviderId,
              keyId: key.id,
              keyStatus: key.status,
              providerLabel: getProvider(key.provider as ProviderId).label,
            })),
    );
    // Best model first, so "Auto" starts with the strongest one available.
    chatModels.sort(
      (a, b) =>
        Number(b.keyStatus === "healthy") - Number(a.keyStatus === "healthy") ||
        modelQualityScore(b.id) - modelQualityScore(a.id),
    );
    return [
      ...new Map(chatModels.map((model) => [`${model.provider}:${model.id}`, model])).values(),
    ];
  }, [apiKeys.data]);
  const uniqueImageModels = useMemo<SkillModelOption[]>(() => {
    const models = (apiKeys.data ?? []).flatMap((key) =>
      key.status === "unhealthy"
        ? []
        : readStoredModels(key.models)
            .filter((model) => model.kind === "image" && model.health !== "unavailable")
            .map((model) => ({
              model: {
                provider: key.provider as ProviderId,
                model: model.id,
                keyId: key.id,
              },
              label: `${model.name} · ${getProvider(key.provider as ProviderId).label}`,
            })),
    );
    return [...new Map(models.map((item) => [encodeSkillModel(item.model), item])).values()];
  }, [apiKeys.data]);
  const skillModelOptions = useMemo<Record<SkillId, SkillModelOption[]>>(() => {
    const chatOptions = uniqueChatModels.map((model) => ({
      model: { provider: model.provider, model: model.id, keyId: model.keyId },
      label: `${model.name} · ${model.providerLabel}`,
    }));
    const rankOptions = (skill: SkillId, options: SkillModelOption[]) => {
      const byModel = new Map(options.map((option) => [encodeSkillModel(option.model), option]));
      return rankSkillModels(
        skill,
        options.map((option) => option.model),
      ).flatMap((model) => {
        const option = byModel.get(encodeSkillModel(model));
        return option ? [option] : [];
      });
    };
    return {
      coding: rankOptions("coding", chatOptions),
      research: rankOptions("research", chatOptions),
      image: rankOptions("image", uniqueImageModels),
      general: rankOptions("general", chatOptions),
    };
  }, [uniqueChatModels, uniqueImageModels]);
  const orderedSkillModels = useMemo<Record<SkillId, SkillModelRef[]>>(
    () =>
      Object.fromEntries(
        SKILL_PROFILES.map(({ id }) => {
          const options = skillModelOptions[id].map((option) => option.model);
          const available = new Set(options.map(encodeSkillModel));
          const custom = skillProfiles[id].flatMap((value) => {
            const model = decodeSkillModel(value);
            return model && available.has(encodeSkillModel(model)) ? [model] : [];
          });
          const customSet = new Set(custom.map(encodeSkillModel));
          const automatic = rankSkillModels(id, options).filter(
            (model) => !customSet.has(encodeSkillModel(model)),
          );
          const limit = id === "image" ? 8 : 12;
          return [id, [...custom, ...automatic].slice(0, limit)];
        }),
      ) as Record<SkillId, SkillModelRef[]>,
    [skillModelOptions, skillProfiles],
  );
  const isAuto = selectedModel === AUTO_MODEL;
  const selectedChatModel = isAuto
    ? uniqueChatModels[0]
    : uniqueChatModels.find(
        (model) => JSON.stringify([model.provider, model.id, model.keyId]) === selectedModel,
      );
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  useEffect(() => {
    // A picked model that disappeared (key removed, model retired) falls back to Auto.
    if (!isAuto && !selectedChatModel) setSelectedModel(AUTO_MODEL);
  }, [isAuto, selectedChatModel]);

  useEffect(() => {
    setMenuOpen(!effectiveMobile);
  }, [effectiveMobile]);

  /** Reads a reply aloud in HAI's female voice, or stops if that reply is already being read. */
  const readAloud = (id: number | string, text: string, onDone?: () => void) => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) {
      onDone?.();
      return;
    }
    synth.cancel();
    if (speakingIdRef.current === id) {
      speakingIdRef.current = null;
      setSpeakingId(null);
      return;
    }
    const spoken = speakableText(text);
    if (!spoken) {
      onDone?.();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(spoken);
    const voice = femaleVoiceRef.current;
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || navigator.language || "en-US";
    utterance.pitch = 1.1;
    const done = () => {
      if (speakingIdRef.current !== id) return;
      speakingIdRef.current = null;
      setSpeakingId(null);
      onDone?.();
    };
    utterance.onend = done;
    utterance.onerror = done;
    speakingIdRef.current = id;
    setSpeakingId(id);
    synth.speak(utterance);
  };

  const runVoiceCommand = (command: NonNullable<ReturnType<typeof matchVoiceCommand>>) => {
    if (command === "new_chat") startNewConversation();
    else if (command === "open_api_manager") {
      setMenuOpen(true);
      setMenuView("api");
    } else if (command === "open_settings") {
      setMenuOpen(true);
      setMenuView("settings");
    } else if (command === "open_menu") setMenuOpen(true);
    else setMenuOpen(false);
  };

  const joinDraft = (before: string, spoken: string) =>
    [before.trim(), spoken].filter(Boolean).join(" ");

  const speech = useSpeechInput({
    onInterim: (spoken) => setChatDraft(joinDraft(draftBeforeVoiceRef.current, spoken)),
    onFinal: (spoken) => handleSpoken(draftBeforeVoiceRef.current, spoken),
  });

  const stopVoiceAssistant = () => {
    conversationActiveRef.current = false;
    setConversationActive(false);
    draftBeforeVoiceRef.current = "";
    speech.abort();
    wakeCancelRef.current?.();
    window.speechSynthesis?.cancel();
    if (speakingIdRef.current !== null) {
      speakingIdRef.current = null;
      setSpeakingId(null);
    }
  };

  /** A spoken sentence is either an app command ("new chat") or a question for HAI. */
  const handleSpoken = (before: string, spoken: string) => {
    const canRunCommand = !before.trim() && attachments.length === 0;
    const command = canRunCommand ? matchVoiceCommand(spoken) : null;
    if (command === "stop_assistant") {
      stopVoiceAssistant();
      return;
    }
    if (command) {
      setChatDraft("");
      runVoiceCommand(command);
      return;
    }
    const browserAction = canRunCommand ? parseBrowserVoiceAction(spoken) : null;
    if (browserAction) {
      stopVoiceAssistant();
      const browserWindow = window.open(browserAction.url, "_blank");
      if (browserWindow) browserWindow.opener = null;
      else window.location.assign(browserAction.url);
      return;
    }
    void sendChatMessage({ text: joinDraft(before, spoken), spoken: true });
  };

  const isWaiting = chatMessages.some((m) => m.pending);
  const wake = useWakeWord({
    active: wakeEnabled && !speech.listening && !isWaiting,
    // "Hello HAI": stop any reply being read and listen for the question straight away.
    onWake: () => {
      conversationActiveRef.current = true;
      setConversationActive(true);
      if (speakingIdRef.current !== null) {
        speakingIdRef.current = null;
        setSpeakingId(null);
      }
      window.speechSynthesis?.cancel();
      draftBeforeVoiceRef.current = chatDraft;
    },
    onInterim: (spoken) => setChatDraft(joinDraft(draftBeforeVoiceRef.current, spoken)),
    onQuestion: (spoken) => handleSpoken(draftBeforeVoiceRef.current, spoken),
    onTimeout: () => {
      conversationActiveRef.current = false;
      setConversationActive(false);
      setChatDraft(draftBeforeVoiceRef.current);
      draftBeforeVoiceRef.current = "";
    },
    onStop: stopVoiceAssistant,
  });
  const wakeCancelRef = useRef(wake.cancel);
  wakeCancelRef.current = wake.cancel;
  /** Listens for a follow-up question, reusing the "Hello HAI" microphone when it is on. */
  const listenForFollowUp = () => {
    if (!wake.listenNow()) {
      draftBeforeVoiceRef.current = "";
      speech.start();
    }
  };

  const toggleWakeWord = () => {
    const next = !wakeEnabled;
    setWakeEnabled(next);
    window.localStorage.setItem(WAKE_WORD_STORAGE_KEY, next ? "on" : "off");
  };

  const toggleSpeech = () => {
    if (wake.capturing) {
      stopVoiceAssistant();
      return;
    }
    if (speech.listening) {
      speech.stop();
      return;
    }
    window.speechSynthesis?.cancel();
    draftBeforeVoiceRef.current = chatDraft;
    speech.start();
  };

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setAttaching(true);
    setAttachError("");
    const next = [...attachments];
    const errors: string[] = [];
    let budget = MAX_ATTACHMENT_CHARS - next.reduce((n, a) => n + attachmentChars(a), 0);
    for (const file of files) {
      const isImage = file.type.startsWith("image/") && file.type !== "image/svg+xml";
      if (isImage && next.filter((a) => a.kind === "image").length >= MAX_IMAGES_PER_MESSAGE) {
        errors.push(`Up to ${MAX_IMAGES_PER_MESSAGE} pictures per message.`);
        continue;
      }
      try {
        const attachment = await readAttachment(file, budget);
        next.push(attachment);
        budget -= attachmentChars(attachment);
      } catch (err) {
        errors.push(err instanceof AttachmentError ? err.message : `Couldn't read "${file.name}".`);
      }
    }
    setAttachments(next);
    setAttachError([...new Set(errors)].join(" "));
    setAttaching(false);
  };

  const removeAttachment = (id: string) => {
    setAttachments((list) => list.filter((a) => a.id !== id));
    setAttachError("");
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const startNewConversation = () => {
    window.speechSynthesis?.cancel();
    stopVoiceAssistant();
    setCurrentConversationId(null);
    setHistoryError("");
    setChatMessages(INITIAL_MESSAGES);
    setChatDraft("");
    setAttachments([]);
    setAttachError("");
    setImageMode(false);
    setMenuView("nav");
  };

  const openSavedConversation = async (id: string) => {
    setIsOpeningConversation(true);
    setHistoryError("");
    try {
      const result = await loadConversation({ data: { id } });
      setCurrentConversationId(result.conversation.id);
      setChatMessages([INITIAL_MESSAGES[0]!, ...result.messages]);
      if (result.truncated) {
        setHistoryError("Showing the most recent 1,000 messages in this conversation.");
      }
      setMenuOpen(false);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Could not load this saved conversation.",
      );
    } finally {
      setIsOpeningConversation(false);
    }
  };

  const removeSavedConversation = async (id: string, title: string) => {
    if (!window.confirm(`Delete "${title}" and its saved messages?`)) return;
    setHistoryError("");
    try {
      const result = await deleteConversation({ data: { id } });
      if (currentConversationId === id) startNewConversation();
      await queryClient.invalidateQueries({ queryKey: ["hai-conversations", user?.id] });
      if (result.warning) setHistoryError(result.warning);
    } catch (error) {
      setHistoryError(
        error instanceof Error ? error.message : "Could not delete this conversation.",
      );
    }
  };

  const signInWithGoogle = async () => {
    setAuthError("");
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) setAuthError("Google sign-in didn't complete. Please try again.");
  };

  const signOut = async () => {
    await queryClient.cancelQueries({ queryKey: ["hai-keys"] });
    queryClient.removeQueries({ queryKey: ["hai-keys"] });
    await queryClient.cancelQueries({ queryKey: ["hai-conversations"] });
    queryClient.removeQueries({ queryKey: ["hai-conversations"] });
    await supabase.auth.signOut();
    setCurrentConversationId(null);
    setChatMessages(INITIAL_MESSAGES);
    setMenuView("nav");
  };

  const sendChatMessage = async (opts: { text?: string; spoken?: boolean } = {}) => {
    const text = (opts.text ?? chatDraft).trim();
    if (
      (!text && attachments.length === 0) ||
      attaching ||
      chatMessages.some((message) => message.pending)
    )
      return;

    const sent = attachments;
    const images = sent.filter((a) => a.kind === "image").map((a) => a.dataUrl);
    const files = sent.flatMap((a) => (a.kind === "image" ? [] : [{ name: a.name, kind: a.kind }]));
    const wantsImage = imageMode || isImageRequest(text);
    const skill = detectSkill(text, wantsImage);
    const orderedChatModels =
      selectedModel === AUTO_MODEL
        ? orderedSkillModels[skill].flatMap((reference) => {
            const match = uniqueChatModels.find(
              (model) =>
                encodeSkillModel({
                  provider: model.provider,
                  model: model.id,
                  keyId: model.keyId,
                }) === encodeSkillModel(reference),
            );
            return match ? [match] : [];
          })
        : [];
    const chatModelForTurn =
      selectedModel === AUTO_MODEL
        ? (orderedChatModels[0] ?? selectedChatModel)
        : selectedChatModel;
    const orderedImageModels = orderedSkillModels.image;
    const modelText = buildModelText(text, sent);
    const userMessage: ChatMessage = {
      id: Date.now(),
      role: "user",
      text,
      ...(modelText !== text ? { modelText } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files } : {}),
    };
    const pendingId = Date.now() + 1;
    const history = [...chatMessages, userMessage];
    setChatMessages([
      ...history,
      {
        id: pendingId,
        role: "assistant",
        text: wantsImage ? "Painting your image…" : "Tuning the signal…",
        pending: true,
      },
    ]);
    setChatDraft("");
    setAttachments([]);
    setAttachError("");
    setImageMode(false);

    const settle = (
      reply: Omit<ChatMessage, "id" | "role">,
      replyId: number | string = pendingId,
    ) => {
      setChatMessages((messages) =>
        messages.map((m) =>
          m.id === pendingId ? { id: replyId, role: "assistant", ...reply } : m,
        ),
      );
      // A spoken command gets a spoken answer.
      if (opts.spoken && reply.text) {
        readAloud(replyId, reply.text, () => {
          if (conversationActiveRef.current) listenForFollowUp();
        });
      }
    };

    if (!user || user.is_anonymous) {
      settle({
        text: "Sign in with Google to save your chats and use HAI.",
        local: true,
      });
      return;
    }

    let conversationId = currentConversationId;
    try {
      const saved = await saveMessage({
        data: {
          ...(conversationId ? { conversationId } : {}),
          role: "user",
          text,
          ...(modelText !== text ? { modelText } : {}),
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        },
      });
      conversationId = saved.conversationId;
      setCurrentConversationId(conversationId);
      setChatMessages((messages) =>
        messages.map((message) =>
          message.id === userMessage.id
            ? {
                ...message,
                id: saved.message.id,
                ...(saved.message.images ? { images: saved.message.images } : {}),
              }
            : message,
        ),
      );
      if (saved.warning) setHistoryError(saved.warning);
      else setHistoryError("");
      void queryClient.invalidateQueries({ queryKey: ["hai-conversations", user.id] });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save your message to chat history.";
      setHistoryError(message);
      settle({
        text: "I couldn't save this message, so I didn't send it. Please try again.",
        local: true,
      });
      return;
    }

    const settleAndSaveReply = async (reply: Omit<ChatMessage, "id" | "role">) => {
      if (reply.local || !conversationId) {
        settle(reply);
        return;
      }
      try {
        const saved = await saveMessage({
          data: {
            conversationId,
            role: "assistant",
            text: reply.text,
            ...(reply.image ? { image: reply.image } : {}),
            ...(reply.imagePrompt ? { imagePrompt: reply.imagePrompt } : {}),
            ...(reply.meta ? { meta: reply.meta } : {}),
            ...(reply.sources ? { sources: reply.sources } : {}),
          },
        });
        if (saved.warning) setHistoryError(saved.warning);
        else setHistoryError("");
        void queryClient.invalidateQueries({ queryKey: ["hai-conversations", user.id] });
        settle(
          {
            ...reply,
            ...(saved.message.image ? { image: saved.message.image } : {}),
          },
          saved.message.id,
        );
      } catch (error) {
        setHistoryError(
          error instanceof Error ? error.message : "The reply could not be saved to chat history.",
        );
        settle(reply);
      }
    };

    if (wantsImage) {
      const prompt = imagePrompt(text);
      if (!prompt) {
        settle({
          text: "Describe the picture you want, then send it with the image button on.",
          local: true,
        });
        return;
      }
      try {
        const result = await makeImage({
          data: {
            prompt,
            ...(images.length ? { images } : {}),
            ...(orderedImageModels.length
              ? {
                  preferredModels: orderedImageModels.map((model) => ({
                    id: model.keyId,
                    model: model.model,
                  })),
                }
              : {}),
          },
        });
        if (result.ok) {
          await settleAndSaveReply({
            text: images.length ? "Here's your edited image." : "Here's your image.",
            image: result.dataUrl,
            imagePrompt: prompt,
            meta: `${result.provider} · ${result.model}${result.fallbackReason ? ` · ${result.fallbackReason}` : ""}`,
          });
        } else {
          settle({ text: result.message, local: true });
        }
      } catch {
        settle({
          text: "The image maker couldn't finish this picture. Please try again.",
          local: true,
        });
      }
      return;
    }

    if (!chatModelForTurn) {
      await settleAndSaveReply({
        text: "Add an API key and wait for an available chat model in the API Manager.",
        local: true,
      });
      return;
    }

    try {
      const result = await chat({
        data: {
          provider: chatModelForTurn.provider,
          model: chatModelForTurn.id,
          keyId: chatModelForTurn.keyId,
          messages: buildTurns(history),
          ...(orderedChatModels.length
            ? {
                preferredModels: orderedChatModels.map((model) => ({
                  provider: model.provider,
                  model: model.id,
                  keyId: model.keyId,
                })),
              }
            : {}),
          ...(opts.spoken ? { spoken: true } : {}),
        },
      });
      if (result.ok) {
        const failovers = result.attempts.length;
        const switched = result.model !== result.requestedModel;
        await settleAndSaveReply({
          text: result.text,
          ...(result.sources?.length ? { sources: result.sources } : {}),
          meta: `${result.providerLabel} · ${result.model}${
            switched
              ? ` · auto-switched from ${result.requestedModel}`
              : failovers
                ? ` · after ${failovers} failover${failovers > 1 ? "s" : ""}`
                : ""
          }`,
        });
      } else {
        await settleAndSaveReply({ text: result.message, local: true });
      }
      void queryClient.invalidateQueries({ queryKey: ["hai-keys"] });
    } catch {
      await settleAndSaveReply({ text: "The signal dropped. Please try again.", local: true });
    }
  };

  const voiceListening = speech.listening || wake.capturing;
  const orbState: OrbState = voiceListening
    ? "listening"
    : speakingId !== null
      ? "speaking"
      : isWaiting
        ? "thinking"
        : "idle";
  const voiceLive = voiceListening || speakingId !== null;
  const composerError = speech.error || attachError || (wakeEnabled ? wake.error : "");
  const composerNote = voiceListening
    ? "Listening… say your message or command. HAI sends it when you pause."
    : composerError || (wake.listening ? "Say “Hello HAI” to talk to me." : "");

  return (
    <div className={`cosmic-experience ${effectiveMobile ? "is-mobile-mode" : ""}`}>
      <CosmicDustScene />
      <button
        type="button"
        className="viewport-mode-toggle"
        onClick={() => setMobileMode((active) => !active)}
        aria-label={effectiveMobile ? "Switch to desktop mode" : "Switch to mobile mode"}
        aria-pressed={effectiveMobile}
        title={effectiveMobile ? "Desktop mode" : "Mobile mode"}
      >
        {effectiveMobile ? <Monitor aria-hidden="true" /> : <Smartphone aria-hidden="true" />}
      </button>
      {!menuOpen && (
        <button
          type="button"
          className="menu-toggle"
          onClick={() => setMenuOpen(true)}
          aria-label="Open navigation"
        >
          <PanelLeftOpen aria-hidden="true" />
        </button>
      )}
      {menuOpen && (
        <button
          type="button"
          className="menu-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <aside
        className={`side-menu ${menuOpen ? "is-open" : ""} ${menuView === "api" ? "side-menu--api" : ""}`}
        aria-label="Chat navigation"
      >
        <header className="side-menu__header">
          <div className="side-menu__brand">
            <span className="side-menu__logo">
              <Sparkles aria-hidden="true" />
            </span>
            <div>
              <p className="chat-eyebrow">ORBITAL</p>
              <h2>HAI</h2>
            </div>
          </div>
          <button
            type="button"
            className="side-menu__icon-button"
            onClick={() => setMenuOpen(false)}
            aria-label="Close navigation"
          >
            <PanelLeftClose aria-hidden="true" />
          </button>
        </header>
        {menuView === "api" ? (
          <div className="side-menu__settings side-menu__api">
            <button type="button" className="side-menu__back" onClick={() => setMenuView("nav")}>
              <ArrowLeft aria-hidden="true" />
              Navigation
            </button>
            <div className="side-menu__section-title">
              <KeyRound aria-hidden="true" />
              <span>API Manager</span>
            </div>
            <ApiManager
              user={user}
              onSignIn={() => void signInWithGoogle()}
              onUseModel={(modelId, modelProvider, keyId) =>
                setSelectedModel(JSON.stringify([modelProvider, modelId, keyId]))
              }
            />
          </div>
        ) : menuView === "skills" ? (
          <div className="side-menu__settings side-menu__skills">
            <button type="button" className="side-menu__back" onClick={() => setMenuView("nav")}>
              <ArrowLeft aria-hidden="true" />
              Navigation
            </button>
            <div className="side-menu__section-title">
              <Sparkles aria-hidden="true" />
              <span>Skills</span>
            </div>
            <SkillManager
              profiles={skillProfiles}
              models={skillModelOptions}
              error={skillStorageError}
              onChange={(profiles) => {
                setSkillStorageError("");
                setSkillProfiles(profiles);
              }}
            />
          </div>
        ) : menuView === "settings" ? (
          <div className="side-menu__settings">
            <button type="button" className="side-menu__back" onClick={() => setMenuView("nav")}>
              <ArrowLeft aria-hidden="true" />
              Navigation
            </button>
            <div className="side-menu__section-title">
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </div>
            <div className="settings-option">
              <div className="settings-option__text">
                <strong>Wake word “Hello HAI”</strong>
                <small>
                  Say “Hello HAI” and ask your question. HAI listens while this page is open.
                </small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={wakeEnabled}
                aria-label="Wake word Hello HAI"
                className={`settings-switch ${wakeEnabled ? "is-on" : ""}`}
                onClick={toggleWakeWord}
              >
                <span aria-hidden="true" />
              </button>
            </div>
            <div className="settings-option">
              <div className="settings-option__text">
                <strong>Voice</strong>
                <small>
                  {voiceName ? `Female · ${voiceName}` : "Female (your device's voice)"}
                </small>
              </div>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="new-chat-button"
              onClick={startNewConversation}
              disabled={isWaiting || isOpeningConversation}
            >
              <Plus aria-hidden="true" />
              New conversation
            </button>
            <button type="button" className="new-chat-button" onClick={() => setMenuView("skills")}>
              <Sparkles aria-hidden="true" />
              Skills
            </button>
            <div className="side-menu__section-title">
              <History aria-hidden="true" />
              <span>Chat history</span>
            </div>
            {isPersistentUser ? (
              <>
                {(historyError || historyQuery.isError) && (
                  <p className="api-error" role="alert">
                    {historyError ||
                      (historyQuery.error instanceof Error
                        ? historyQuery.error.message
                        : "Could not load saved conversations.")}
                  </p>
                )}
                <div className="history-list" aria-label="Saved conversations">
                  {historyQuery.isPending ? (
                    <p className="history-empty">Loading saved chats…</p>
                  ) : savedConversations.length === 0 ? (
                    <p className="history-empty">Your saved chats will appear here.</p>
                  ) : (
                    savedConversations.map((conversation) => (
                      <div className="history-row" key={conversation.id}>
                        <button
                          type="button"
                          className={`history-item ${currentConversationId === conversation.id ? "is-active" : ""}`}
                          onClick={() => void openSavedConversation(conversation.id)}
                          disabled={isWaiting || isOpeningConversation}
                          aria-current={
                            currentConversationId === conversation.id ? "page" : undefined
                          }
                        >
                          <span>{conversation.title}</span>
                          <small>{new Date(conversation.updatedAt).toLocaleString()}</small>
                        </button>
                        <button
                          type="button"
                          className="history-delete"
                          onClick={() =>
                            void removeSavedConversation(conversation.id, conversation.title)
                          }
                          disabled={isWaiting || isOpeningConversation}
                          aria-label={`Delete ${conversation.title}`}
                          title="Delete conversation"
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
                {historyQuery.hasNextPage && (
                  <button
                    type="button"
                    className="history-more"
                    onClick={() => void historyQuery.fetchNextPage()}
                    disabled={historyQuery.isFetchingNextPage}
                  >
                    {historyQuery.isFetchingNextPage ? "Loading…" : "Load older chats"}
                  </button>
                )}
              </>
            ) : (
              <p className="history-empty">Sign in with Google to save and sync your chats.</p>
            )}
            <div className="side-menu__footer">
              <button type="button" className="new-chat-button" onClick={() => setMenuView("api")}>
                <KeyRound aria-hidden="true" />
                API Manager
              </button>
              {user ? (
                <div className="side-menu__account">
                  <span className="side-menu__avatar" aria-hidden="true">
                    {(displayName(user) ?? user.email ?? "?").charAt(0)}
                  </span>
                  <span className="side-menu__account-text">
                    <strong>
                      {displayName(user) ?? (user.is_anonymous ? "Guest session" : "Signed in")}
                    </strong>
                    <small>{user.email}</small>
                  </span>
                  <button
                    type="button"
                    className="side-menu__icon-button"
                    onClick={() => void signOut()}
                    aria-label="Sign out"
                  >
                    <LogOut aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <GoogleSignInButton onClick={() => void signInWithGoogle()} />
              )}
              {authError && (
                <p className="api-error" role="alert">
                  {authError}
                </p>
              )}
              <button
                type="button"
                className="settings-button"
                onClick={() => setMenuView("settings")}
              >
                <Settings aria-hidden="true" />
                Settings
              </button>
            </div>
          </>
        )}
      </aside>
      <section className="chat-interface" aria-label="HAI chat">
        <div className="chat-messages" aria-live="polite" ref={messagesRef}>
          {chatMessages.map((message) => (
            <div key={message.id} className={`chat-message chat-message--${message.role}`}>
              {message.role === "assistant" && <MessageCircle aria-hidden="true" />}
              {message.pending ? (
                <div className="chat-bubble is-pending">{message.text}</div>
              ) : (
                <div className="chat-message__body">
                  {message.images?.length || message.files?.length ? (
                    <div className="chat-message__attachments">
                      {message.images?.map((url, index) => (
                        <img
                          key={index}
                          src={url}
                          alt={`Attached picture ${index + 1}`}
                          className="chat-thumb"
                        />
                      ))}
                      {message.files?.map((file, index) => (
                        <span key={index} className="chat-file-chip">
                          {file.kind === "zip" ? (
                            <FileArchive aria-hidden="true" />
                          ) : (
                            <FileText aria-hidden="true" />
                          )}
                          {file.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {message.text && (
                    <div className="chat-bubble">
                      <ChatMarkdown text={message.text} />
                    </div>
                  )}
                  {message.sources && message.sources.length > 0 && (
                    <nav className="chat-sources" aria-label="Web sources">
                      <span>Sources</span>
                      {message.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      ))}
                    </nav>
                  )}
                  {message.image && (
                    <figure className="chat-image">
                      <img src={message.image} alt={message.imagePrompt ?? "Generated image"} />
                      <a
                        href={message.image}
                        download="hai-image.jpg"
                        className="chat-image__download"
                      >
                        <Download aria-hidden="true" />
                        Download
                      </a>
                    </figure>
                  )}
                  {message.role === "assistant" && message.meta && (
                    <small className="chat-message__meta">
                      via {message.meta}
                      {!message.image && (
                        <button
                          type="button"
                          className="chat-message__speak"
                          onClick={() => readAloud(message.id, message.text)}
                          aria-label={
                            speakingId === message.id ? "Stop reading aloud" : "Read aloud"
                          }
                        >
                          {speakingId === message.id ? (
                            <VolumeX aria-hidden="true" />
                          ) : (
                            <Volume2 aria-hidden="true" />
                          )}
                        </button>
                      )}
                    </small>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        {(attachments.length > 0 || attaching) && (
          <div className="chat-attachments" aria-label="Attached files">
            {attachments.map((a) => (
              <span key={a.id} className="chat-file-chip">
                {a.kind === "image" ? (
                  <img src={a.dataUrl} alt="" className="chat-file-chip__thumb" />
                ) : a.kind === "zip" ? (
                  <FileArchive aria-hidden="true" />
                ) : (
                  <FileText aria-hidden="true" />
                )}
                <span className="chat-file-chip__name">{a.name}</span>
                {a.kind === "zip" && <small>{a.files.length} files</small>}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.name}`}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
            {attaching && <span className="chat-file-chip is-pending">Reading files…</span>}
          </div>
        )}
        {composerNote && (
          <p
            className={`chat-composer-note ${composerError && !voiceListening ? "is-error" : ""}`}
            role="status"
          >
            {composerNote}
          </p>
        )}
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendChatMessage();
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <label className="chat-model-control">
            <span>Model</span>
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={uniqueChatModels.length === 0}
              aria-label="Chat model"
            >
              {uniqueChatModels.length === 0 ? (
                <option value={AUTO_MODEL}>Add an API key</option>
              ) : (
                [
                  <option key={AUTO_MODEL} value={AUTO_MODEL}>
                    Auto · best model ({uniqueChatModels[0]?.name})
                  </option>,
                  ...uniqueChatModels.map((model) => (
                    <option
                      key={JSON.stringify([model.provider, model.id, model.keyId])}
                      value={JSON.stringify([model.provider, model.id, model.keyId])}
                    >
                      {model.name} ({model.id}) · {model.providerLabel}
                    </option>
                  )),
                ]
              )}
            </select>
          </label>
          <button
            type="button"
            className="chat-composer__tool"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach images, zip or files"
            title="Attach images, zip or files"
          >
            <Paperclip aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`chat-composer__tool ${imageMode ? "is-active" : ""}`}
            onClick={() => setImageMode((on) => !on)}
            aria-pressed={imageMode}
            aria-label="Create an image"
            title="Create an image"
          >
            <ImagePlus aria-hidden="true" />
          </button>
          <textarea
            ref={composerRef}
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendChatMessage();
              }
            }}
            placeholder={imageMode ? "Describe the image to create…" : "Ask HAI anything…"}
            aria-label="Message HAI"
            rows={1}
          />
          <button
            type="button"
            className={`chat-composer__tool ${voiceListening ? "is-active is-listening" : ""}`}
            onClick={toggleSpeech}
            aria-pressed={voiceListening}
            aria-label={voiceListening ? "Stop listening" : "Speak to HAI"}
            title={
              speech.supported ? "Speak to HAI" : "Voice input isn't supported in this browser"
            }
          >
            {voiceListening ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </button>
          <button
            type="submit"
            aria-label="Send message"
            disabled={(!chatDraft.trim() && attachments.length === 0) || attaching}
          >
            <Send aria-hidden="true" />
          </button>
        </form>
      </section>
      <section className="orb-overlay" aria-label="Voice orb">
        <div className="orb-stage">
          <RadiationField active={voiceLive} />
          <VoiceOrb
            state={orbState}
            onController={(controller) => {
              orbRef.current = controller;
            }}
          />
        </div>
      </section>
    </div>
  );
}
