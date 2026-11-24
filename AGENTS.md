<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules

- The WebGL experience (three.js + orbloom) lives in `src/components/cosmic/` and is loaded on `/` via `React.lazy` inside `<ClientOnly>`; these libraries need the browser and must never be statically imported from a route. Keep every package it imports in `optimizeDeps.include` in vite.config.ts, or late dep discovery reloads the page with duplicate React.
- Cosmic-scene styling lives in `src/cosmic.css`, imported at the top of `src/styles.css`; it was ported verbatim from the original Bolt app to keep the look identical.
- HAI provider routing lives in `src/lib/hai/`: `providers.ts` (client-safe catalog + pure routing/URL rules, unit-tested; `orderRouteCandidates` decides chat order: chosen model, then the best other available model by `modelQualityScore`, capped by `MAX_ROUTE_ATTEMPTS`), `hai.server.ts` + `crypto.server.ts` (provider calls, AES-256-GCM key sealing), `hai.functions.ts` (auth-required server functions). All providers are called through their OpenAI-compatible `/chat/completions` endpoints so one call path serves every provider. Model lists come from `discovery.ts`: one adapter per provider in `MODEL_LIST_ADAPTERS` (official list URL, pagination, capability filter, whether the list proves the key) driven by a shared fetch loop, so adding a provider means adding an adapter, never a hardcoded model list.
- Provider API keys: metadata in `api_keys` (owner can only SELECT/DELETE via RLS), ciphertext in `api_key_secrets` (service role only); inserts and status updates go through server functions with the admin client so the browser never sees a key or can fake a health status.
- The schema (api_keys, api_key_secrets, hai_conversations, hai_messages, private `hai-chat-files` bucket) was recreated in one Lovable Cloud migration from the original project; chat history writes run as the signed-in user so RLS enforces ownership. Every reply after a saved user message is saved, notices included (marked with the `hai:notice` meta so they are never sent to models); the open chat id is kept in localStorage per user so a reload reopens it.
- Voice uses the browser's own speech APIs (free, no gateway credits): `src/lib/hai/voice.ts` holds the pure wake-word, question-after-wake (`readQuestionAfterWake`) and female-voice rules (unit-tested). `src/hooks/use-wake-word.ts` keeps one continuous recognition session: after "Hello HAI" it reads the question from that same session (no restart, no spoken reply) so the first words are never lost, and `listenNow()` reuses it for follow-ups; it pauses while HAI thinks. `src/lib/hai/speakable.ts` decides what is read aloud. Voice-opened sites go through `openInNewTab` (`src/lib/hai/open-tab.ts`, unit-tested): always a new tab, never the HAI tab; when the pop-up blocker stops it, an "Open …" button is shown instead.
- Skills (`src/lib/hai/skills.ts`, `SkillManager.tsx`) only reorder routing on "Auto": the client sends `preferredModels`, the server applies them via `orderPreferredCandidates` before the normal order, so pinned models can never bypass key/model health. Stored models carry `kind` (chat/image; missing = chat). Cited web sources are parsed by `grounding.ts` from the provider response only.
