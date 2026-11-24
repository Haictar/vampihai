import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ChatConversationPage, SavedChatFile, SavedChatMessage } from "./chat-history";

const CHAT_STORAGE_BUCKET = "hai-chat-files";
const SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;

type Table<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  role: "user" | "assistant";
  text: string;
  model_text: string | null;
  image_paths: string[];
  image_path: string | null;
  image_url: string | null;
  image_prompt: string | null;
  meta: string | null;
  files: Json;
  sources: Json;
  created_at: string;
};

type ChatHistoryDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      hai_conversations: Table<
        ConversationRow,
        { id?: string; user_id: string; title: string; created_at?: string; updated_at?: string },
        { title?: string; updated_at?: string }
      >;
      hai_messages: Table<
        MessageRow,
        {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: "user" | "assistant";
          text: string;
          model_text?: string | null;
          image_paths?: string[];
          image_path?: string | null;
          image_url?: string | null;
          image_prompt?: string | null;
          meta?: string | null;
          files?: Json;
          sources?: Json;
          created_at?: string;
        },
        never
      >;
    };
  };
};

function historyClient(client: SupabaseClient<Database>) {
  // Lovable adds these table types when the included database prompt is applied.
  return client as unknown as SupabaseClient<ChatHistoryDatabase>;
}

function requireGoogleAccount(claims: Record<string, unknown>) {
  if (claims["is_anonymous"] === true) {
    throw new Error("Sign in with Google to save and sync chat history.");
  }
}

function asJson(value: unknown): Json {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Chat metadata could not be saved.");
  return JSON.parse(serialized) as Json;
}

const fileSchema = z.object({
  name: z.string().max(300),
  kind: z.enum(["file", "zip"]),
});

const filesSchema = z.array(fileSchema).max(100);
const sourcesSchema = z.array(
  z.object({
    title: z.string().max(500),
    url: z.string().url().max(2000),
  }),
);

function dataUrlImage(value: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error("Unsupported chat image format.");
  const binary = atob(match[2]!);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const extension = match[1] === "image/jpeg" ? "jpg" : match[1]!.split("/")[1]!;
  return { bytes, contentType: match[1]!, extension };
}

async function uploadPrivateImage(
  client: SupabaseClient<ChatHistoryDatabase>,
  userId: string,
  conversationId: string,
  messageId: string,
  image: string,
  index: number,
) {
  const parsed = dataUrlImage(image);
  const path = `${userId}/${conversationId}/${messageId}/${index}.${parsed.extension}`;
  const { error } = await client.storage
    .from(CHAT_STORAGE_BUCKET)
    .upload(path, parsed.bytes, { contentType: parsed.contentType, upsert: false });
  if (error) throw new Error("Could not save an image to your private chat history.");
  return path;
}

async function signedImageUrl(client: SupabaseClient<ChatHistoryDatabase>, path: string) {
  const { data, error } = await client.storage
    .from(CHAT_STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error("Could not open an image in this chat.");
  }
  return data.signedUrl;
}

async function toSavedMessage(
  client: SupabaseClient<ChatHistoryDatabase>,
  row: MessageRow,
  signedMedia?: { images: string[]; image?: string },
): Promise<SavedChatMessage> {
  const files = filesSchema.parse(row.files);
  const sources = sourcesSchema.parse(row.sources);
  const images =
    signedMedia?.images ??
    (await Promise.all((row.image_paths ?? []).map((path) => signedImageUrl(client, path))));
  const image =
    signedMedia?.image ??
    (row.image_path ? await signedImageUrl(client, row.image_path) : (row.image_url ?? undefined));
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    ...(row.model_text ? { modelText: row.model_text } : {}),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(image ? { image } : {}),
    ...(row.image_prompt ? { imagePrompt: row.image_prompt } : {}),
    ...(row.meta ? { meta: row.meta } : {}),
    ...(sources.length ? { sources } : {}),
    createdAt: row.created_at,
  };
}

const listSchema = z.object({
  offset: z.number().int().min(0).max(100_000),
  limit: z.number().int().min(1).max(50),
});

export const listChatConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => listSchema.parse(input))
  .handler(async ({ data, context }): Promise<ChatConversationPage> => {
    requireGoogleAccount(context.claims);
    const client = historyClient(context.supabase);
    const { data: rows, error } = await client
      .from("hai_conversations")
      .select("id, title, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .range(data.offset, data.offset + data.limit - 1);
    if (error) throw new Error("Could not load your saved conversations.");
    const items = (rows ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
    }));
    return {
      items,
      nextOffset: data.offset + items.length,
      hasMore: items.length === data.limit,
    };
  });

const loadSchema = z.object({ id: z.string().uuid() });

export const loadChatConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => loadSchema.parse(input))
  .handler(async ({ data, context }) => {
    requireGoogleAccount(context.claims);
    const client = historyClient(context.supabase);
    const { data: conversation, error: conversationError } = await client
      .from("hai_conversations")
      .select("id, title, updated_at")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (conversationError) throw new Error("Could not open this conversation.");
    if (!conversation) throw new Error("Conversation not found.");
    const { data: rows, error: messagesError } = await client
      .from("hai_messages")
      .select("*")
      .eq("conversation_id", data.id)
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (messagesError) throw new Error("Could not load messages for this conversation.");
    const messages = await Promise.all(
      [...(rows ?? [])].reverse().map((row) => toSavedMessage(client, row)),
    );
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updated_at,
      },
      messages,
      truncated: (rows ?? []).length === 1000,
    };
  });

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const saveSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    role: z.enum(["user", "assistant"]),
    text: z.string().max(150_000),
    modelText: z.string().max(150_000).optional(),
    images: z.array(z.string().max(8_000_000).regex(IMAGE_DATA_URL)).max(4).optional(),
    files: filesSchema.optional(),
    image: z.string().max(8_000_000).optional(),
    imagePrompt: z.string().max(4000).optional(),
    meta: z.string().max(1000).optional(),
    sources: sourcesSchema.max(20).optional(),
  })
  .strict();

export const saveChatMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => saveSchema.parse(input))
  .handler(async ({ data, context }) => {
    requireGoogleAccount(context.claims);
    if (data.role === "assistant" && !data.conversationId) {
      throw new Error("Start a conversation before saving an assistant reply.");
    }
    if (data.role === "assistant" && data.images?.length) {
      throw new Error("Assistant replies cannot contain user attachment images.");
    }
    const client = historyClient(context.supabase);
    let conversationId = data.conversationId;
    let createdConversation = false;
    if (conversationId) {
      const { data: existing, error } = await client
        .from("hai_conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", context.userId)
        .maybeSingle();
      if (error) throw new Error("Could not verify ownership of this conversation.");
      if (!existing) throw new Error("Conversation not found.");
    } else {
      if (data.role !== "user") throw new Error("A conversation must start with a user message.");
      const title = data.text.trim().slice(0, 80) || "Image conversation";
      const { data: created, error } = await client
        .from("hai_conversations")
        .insert({ user_id: context.userId, title })
        .select("id")
        .single();
      if (error || !created) throw new Error("Could not start a saved conversation.");
      conversationId = created.id;
      createdConversation = true;
    }
    if (!conversationId) throw new Error("Could not start a saved conversation.");
    const activeConversationId = conversationId;

    const messageId = crypto.randomUUID();
    const imagePaths: string[] = [];
    let imagePath: string | null = null;
    let imageUrl: string | null = null;
    let signedImages: string[] = [];
    let signedImage: string | undefined;
    let savedRow: MessageRow | null = null;
    let warning: string | undefined;
    try {
      for (const [index, image] of (data.images ?? []).entries()) {
        imagePaths.push(
          await uploadPrivateImage(
            client,
            context.userId,
            activeConversationId,
            messageId,
            image,
            index,
          ),
        );
      }
      if (data.image) {
        if (data.image.startsWith("data:")) {
          imagePath = await uploadPrivateImage(
            client,
            context.userId,
            activeConversationId,
            messageId,
            data.image,
            0,
          );
        } else {
          const parsed = new URL(data.image);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
            throw new Error("Unsupported generated image URL.");
          }
          imageUrl = parsed.toString();
        }
      }

      signedImages = await Promise.all(imagePaths.map((path) => signedImageUrl(client, path)));
      signedImage = imagePath ? await signedImageUrl(client, imagePath) : (imageUrl ?? undefined);

      const { data: row, error } = await client
        .from("hai_messages")
        .insert({
          id: messageId,
          conversation_id: activeConversationId,
          user_id: context.userId,
          role: data.role,
          text: data.text,
          model_text: data.modelText ?? null,
          image_paths: imagePaths,
          image_path: imagePath,
          image_url: imageUrl,
          image_prompt: data.imagePrompt ?? null,
          meta: data.meta ?? null,
          files: asJson(data.files ?? []),
          sources: asJson(data.sources ?? []),
        })
        .select("*")
        .single();
      if (error || !row) throw new Error("Could not save this chat message.");
      savedRow = row;

      const { error: updateError } = await client
        .from("hai_conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", activeConversationId)
        .eq("user_id", context.userId);
      warning = updateError
        ? "The conversation's recent activity time could not be updated."
        : undefined;
      if (updateError)
        console.error("chat conversation timestamp update failed", activeConversationId);
    } catch (error) {
      const uploadedPaths = [...imagePaths, ...(imagePath ? [imagePath] : [])];
      if (uploadedPaths.length) {
        const { error: cleanupError } = await client.storage
          .from(CHAT_STORAGE_BUCKET)
          .remove(uploadedPaths);
        if (cleanupError) {
          console.error("chat image cleanup failed", activeConversationId);
        }
      }
      if (createdConversation) {
        const { error: cleanupError } = await client
          .from("hai_conversations")
          .delete()
          .eq("id", activeConversationId)
          .eq("user_id", context.userId);
        if (cleanupError) console.error("empty chat cleanup failed", activeConversationId);
      }
      throw error;
    }
    if (!savedRow) throw new Error("Could not save this chat message.");
    return {
      conversationId: activeConversationId,
      message: await toSavedMessage(client, savedRow, {
        images: signedImages,
        ...(signedImage ? { image: signedImage } : {}),
      }),
      ...(warning ? { warning } : {}),
    };
  });

export const deleteChatConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => loadSchema.parse(input))
  .handler(async ({ data, context }) => {
    requireGoogleAccount(context.claims);
    const client = historyClient(context.supabase);
    const { data: conversation, error: lookupError } = await client
      .from("hai_conversations")
      .select("id")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (lookupError) throw new Error("Could not verify ownership of this conversation.");
    if (!conversation) throw new Error("Conversation not found.");
    const { data: messages, error: messagesError } = await client
      .from("hai_messages")
      .select("image_paths, image_path")
      .eq("conversation_id", data.id)
      .eq("user_id", context.userId);
    if (messagesError) throw new Error("Could not prepare this conversation for deletion.");
    const imagePaths = (messages ?? []).flatMap((message) => [
      ...(message.image_paths ?? []),
      ...(message.image_path ? [message.image_path] : []),
    ]);
    const { error: deleteError } = await client
      .from("hai_conversations")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (deleteError) throw new Error("Could not delete this conversation.");
    if (imagePaths.length) {
      const { error: cleanupError } = await client.storage
        .from(CHAT_STORAGE_BUCKET)
        .remove(imagePaths);
      if (cleanupError) {
        console.error("deleted chat image cleanup failed", data.id);
        return { deleted: data.id, warning: "Some private image files could not be removed." };
      }
    }
    return { deleted: data.id };
  });
