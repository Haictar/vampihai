import { useEffect, useRef, useState } from "react";
import { getRecognitionCtor, type SpeechRecognitionLike } from "@/hooks/use-speech-input";
import { STOP_PHRASE } from "@/lib/hai/commands";
import { findWakeWord } from "@/lib/hai/voice";

const RESTART_DELAY_MS = 400;

/**
 * Listens in the background for "Hello HAI" while `active`. When heard, stops listening and calls
 * `onWake` with anything said straight after the wake word. Restarts itself after browser timeouts.
 */
export function useWakeWord(opts: {
  active: boolean;
  onWake: (rest: string) => void;
  /** Called when the person says "stop" (for example while HAI is reading a reply aloud). */
  onStop?: () => void;
}) {
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const onWakeRef = useRef(opts.onWake);
  onWakeRef.current = opts.onWake;
  const onStopRef = useRef(opts.onStop);
  onStopRef.current = opts.onStop;

  useEffect(() => {
    if (!opts.active) return;
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("This browser can't listen for “Hello HAI”. Try Chrome or Edge.");
      return;
    }
    let stopped = false;
    let recognition: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const begin = () => {
      if (stopped) return;
      const r = new Ctor();
      r.lang = navigator.language || "en-US";
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]!;
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal && onStopRef.current) {
            const said = transcript.toLowerCase().replace(/[.!?,]+/g, "").trim();
            if (STOP_PHRASE.test(said)) {
              onStopRef.current();
              continue;
            }
          }
          const heard = findWakeWord(transcript);
          if (!heard) continue;
          // Wait for the end of the sentence when words follow, so the whole question is sent.
          if (heard.rest && !result.isFinal) continue;
          stopped = true;
          r.abort();
          setListening(false);
          onWakeRef.current(heard.rest);
          return;
        }
      };
      r.onerror = (event) => {
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          stopped = true;
          setError("Allow the microphone so HAI can hear “Hello HAI”.");
        }
      };
      r.onend = () => {
        setListening(false);
        if (!stopped) restartTimer = setTimeout(begin, RESTART_DELAY_MS);
      };
      try {
        r.start();
        recognition = r;
        setListening(true);
        setError("");
      } catch {
        restartTimer = setTimeout(begin, RESTART_DELAY_MS * 3);
      }
    };

    begin();
    return () => {
      stopped = true;
      clearTimeout(restartTimer);
      recognition?.abort();
      setListening(false);
    };
  }, [opts.active]);

  return { listening, error };
}
