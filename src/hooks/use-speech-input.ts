import { useCallback, useEffect, useRef, useState } from "react";

// Minimal typing for the browser Web Speech API (not in TypeScript's DOM lib everywhere).
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: SpeechRecognitionResultLike };
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, unknown>;
  return (w["SpeechRecognition"] ?? w["webkitSpeechRecognition"] ?? null) as SpeechRecognitionCtor | null;
}

const ERROR_TEXT: Record<string, string> = {
  "not-allowed": "Microphone permission was denied. Allow the microphone to speak to Jimmy.",
  "service-not-allowed": "Voice input isn't allowed in this browser.",
  "no-speech": "I didn't hear anything. Tap the microphone and try again.",
  "audio-capture": "No microphone was found.",
  network: "Voice input needs an internet connection.",
};

/**
 * Speech-to-text for the chat box. Listens until the person pauses, streams the words as they
 * are recognised, then hands the final sentence to `onFinal`.
 */
export function useSpeechInput(handlers: { onInterim: (text: string) => void; onFinal: (text: string) => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
    return () => recognitionRef.current?.abort();
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError("Voice input isn't supported in this browser. Try Chrome, Edge or Safari.");
      return;
    }
    recognitionRef.current?.abort();
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    let finalText = "";
    recognition.onresult = (event) => {
      let interim = "";
      finalText = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]!;
        const words = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += words;
        else interim += words;
      }
      handlersRef.current.onInterim(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      setError(ERROR_TEXT[event.error] ?? "Voice input stopped unexpectedly. Please try again.");
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      const spoken = finalText.trim();
      if (spoken) handlersRef.current.onFinal(spoken);
    };
    setError("");
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      setError("Voice input couldn't start. Please try again.");
    }
  }, []);

  /** Stops listening; whatever was already recognised is still sent. */
  const stop = useCallback(() => recognitionRef.current?.stop(), []);

  /** Stops listening and throws away anything heard, so nothing is sent. */
  const abort = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onend = null;
    recognitionRef.current = null;
    recognition.abort();
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop, abort, clearError: () => setError("") };
}
