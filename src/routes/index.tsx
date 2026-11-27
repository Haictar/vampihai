import { lazy, Suspense } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";

// WebGL scenes (three.js + orbloom) need the browser, so load them only after hydration.
const CosmicApp = lazy(() =>
  import("@/components/cosmic/CosmicApp").then((m) => ({ default: m.CosmicApp })),
);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Jimmy — Voice Assistant" },
      {
        name: "description",
        content: "Chat with Jimmy by text or voice. Say Hello Jimmy to start, save your conversations, and connect your AI models.",
      },
      { property: "og:title", content: "Jimmy — Voice Assistant" },
      {
        property: "og:description",
        content: "Chat with Jimmy by text or voice. Say Hello Jimmy to start, save your conversations, and connect your AI models.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const fallback = (
    <div className="app-loading-screen" role="status" aria-label="Loading Jimmy">
      <div className="app-loading-content">
        <div className="app-loading-orbit" aria-hidden="true">
          <span />
        </div>
        <strong>Jimmy</strong>
        <span>Aligning the signal…</span>
      </div>
    </div>
  );
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <CosmicApp />
      </Suspense>
    </ClientOnly>
  );
}
