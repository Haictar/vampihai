CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('gemini','groq','nvidia','cohere','custom')),
  model text,
  label text NOT NULL DEFAULT '',
  base_url text,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('healthy','unhealthy','untested')),
  last_error text,
  last_tested_at timestamptz,
  last_used_at timestamptz,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  models_refreshed_at timestamptz,
  models_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_id_idx ON public.api_keys (user_id, created_at);

REVOKE ALL ON public.api_keys FROM anon, authenticated;
GRANT SELECT, DELETE ON public.api_keys TO authenticated;
GRANT ALL ON public.api_keys TO service_role;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their keys" ON public.api_keys
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners can delete their keys" ON public.api_keys
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.api_key_secrets (
  key_id uuid PRIMARY KEY REFERENCES public.api_keys(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.api_key_secrets FROM anon, authenticated;
GRANT ALL ON public.api_key_secrets TO service_role;

ALTER TABLE public.api_key_secrets ENABLE ROW LEVEL SECURITY;

-- Chat history
CREATE TABLE public.hai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hai_conversations_user_updated_idx ON public.hai_conversations (user_id, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hai_conversations TO authenticated;
GRANT ALL ON public.hai_conversations TO service_role;

ALTER TABLE public.hai_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their conversations" ON public.hai_conversations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners can create their conversations" ON public.hai_conversations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners can update their conversations" ON public.hai_conversations
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Owners can delete their conversations" ON public.hai_conversations
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.hai_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER hai_conversations_touch_updated_at
  BEFORE UPDATE ON public.hai_conversations
  FOR EACH ROW EXECUTE FUNCTION public.hai_touch_updated_at();

CREATE TABLE public.hai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.hai_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  text text NOT NULL DEFAULT '',
  model_text text,
  image_paths text[] NOT NULL DEFAULT '{}',
  image_path text,
  image_url text,
  image_prompt text,
  meta text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hai_messages_conversation_created_idx ON public.hai_messages (conversation_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.hai_messages TO authenticated;
GRANT ALL ON public.hai_messages TO service_role;

ALTER TABLE public.hai_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners can view their messages" ON public.hai_messages
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Owners can add messages to their conversations" ON public.hai_messages
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.hai_conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
  );
CREATE POLICY "Owners can update their messages" ON public.hai_messages
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.hai_conversations c
      WHERE c.id = conversation_id AND c.user_id = auth.uid()
    )
  );
CREATE POLICY "Owners can delete their messages" ON public.hai_messages
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- A message must always belong to the owner of its conversation.
CREATE OR REPLACE FUNCTION public.hai_message_owner_matches()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hai_conversations c
    WHERE c.id = NEW.conversation_id AND c.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Message owner must match conversation owner';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hai_message_owner_matches() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER hai_messages_owner_matches
  BEFORE INSERT OR UPDATE ON public.hai_messages
  FOR EACH ROW EXECUTE FUNCTION public.hai_message_owner_matches();

-- Private chat images: <auth.uid>/<conversation_id>/<message_id>/<file>
CREATE POLICY "Owners can upload chat images" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'hai-chat-files' AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "Owners can read chat images" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'hai-chat-files' AND (storage.foldername(name))[1] = auth.uid()::text
  );
CREATE POLICY "Owners can delete chat images" ON storage.objects
  FOR DELETE TO authenticated USING (
    bucket_id = 'hai-chat-files' AND (storage.foldername(name))[1] = auth.uid()::text
  );