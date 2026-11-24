import { useEffect, useRef } from "react";
import type { OrbController, OrbState } from "orbloom";
import "orbloom/styles.css";
import { studioOrbTheme } from "@/components/cosmic/orb/theme";

interface VoiceOrbProps {
  state?: OrbState;
  onController?: (controller: OrbController | null) => void;
}

function applyAmbientMotion(el: HTMLElement) {
  const motion = studioOrbTheme.ambientMotion;
  el.dataset["ambientMotion"] = String(motion.enabled);
  el.style.setProperty("--orb-motion-distance", `${-motion.verticalTravel}px`);
  el.style.setProperty("--orb-motion-scale", String(motion.scale));
  el.style.setProperty("--orb-motion-duration", `${motion.durationSeconds}s`);
  el.style.setProperty("--orb-motion-delay", `${motion.delaySeconds}s`);
}

export function VoiceOrb({ state = "idle", onController }: VoiceOrbProps) {
  const motionRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<OrbController | null>(null);
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;

  useEffect(() => {
    let cancelled = false;
    const motion = motionRef.current;
    const canvas = canvasRef.current;
    if (!motion || !canvas) return;

    applyAmbientMotion(motion);

    void import("orbloom")
      .then(({ createOrb }) => {
        if (cancelled) return;
        try {
          const controller = createOrb(canvas, {
            theme: studioOrbTheme,
            quality: "balanced",
            state: "idle",
            reducedMotion: "user",
            onError: () => motion.classList.add("orb-no-webgl"),
          });
          controllerRef.current = controller;
          onControllerRef.current?.(controller);
        } catch {
          motion.classList.add("orb-no-webgl");
          onControllerRef.current?.(null);
        }
      })
      .catch(() => {
        motion.classList.add("orb-no-webgl");
        onControllerRef.current?.(null);
      });

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
      onControllerRef.current?.(null);
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setState(state);
  }, [state]);

  return (
    <div ref={motionRef} className="orb-motion" aria-label="Voice orb">
      <div className="orb-shell">
        <div className="orb-clip">
          <canvas
            ref={canvasRef}
            className="orb-canvas"
            aria-label="Voice activity"
          />
          <div className="orb-fallback" aria-hidden="true" />
        </div>
        <div className="orb-chrome" aria-hidden="true" />
      </div>
    </div>
  );
}
