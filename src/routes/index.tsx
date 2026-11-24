import { lazy, Suspense } from "react";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";

// WebGL scenes (three.js + orbloom) need the browser, so load them only after hydration.
const CosmicApp = lazy(() =>
  import("@/components/cosmic/CosmicApp").then((m) => ({ default: m.CosmicApp })),
);

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Clear Signal — Orbital Voice Orb" },
      {
        name: "description",
        content: "A voice-reactive cosmic orb surrounded by 3D radiation and drifting cosmic dust.",
      },
      { property: "og:title", content: "Clear Signal — Orbital Voice Orb" },
      {
        property: "og:description",
        content: "A voice-reactive cosmic orb surrounded by 3D radiation and drifting cosmic dust.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const fallback = (
    <div className="app-loading-screen" role="status" aria-label="Loading HAI">
      <div className="app-loading-content">
        <div className="app-loading-orbit" aria-hidden="true">
          <span />
        </div>
        <strong>HAI</strong>
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
