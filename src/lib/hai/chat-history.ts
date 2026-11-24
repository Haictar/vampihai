import type { GroundingSource } from "./grounding";

export interface SavedChatConversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface SavedChatFile {
  name: string;
  kind: "file" | "zip";
}

export interface SavedChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  modelText?: string;
  images?: string[];
  files?: SavedChatFile[];
  image?: string;
  imagePrompt?: string;
  meta?: string;
  sources?: GroundingSource[];
  createdAt: string;
}

export interface ChatConversationPage {
  items: SavedChatConversation[];
  nextOffset: number;
  hasMore: boolean;
}
