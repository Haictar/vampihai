import { useCallback, useEffect, useRef, useState } from "react";
import { getRecognitionCtor, type SpeechRecognitionLike } from "@/hooks/use-speech-input";
import { STOP_PHRASE } from "@/lib/hai/commands";
import { findWakeWord, readQuestionAfterWake, type HeardPhrase } from "@/lib/hai/voice";

const RESTART_DELAY_MS = 250;
/** How long HAI waits for a question after "Hello HAI" before going back to sleep. */
const QUESTION_TIMEOUT_MS = 8000;

/**
 * Listens in the background for "Hello HAI" while `active`. When heard, HAI starts listening
 * for the question at once in the same microphone session (no restart, no spoken reply), streams
 * the words through `onInterim` and hands the finished sentence to `onQuestion`.
 * `listenNow()` does the same without the wake word, for follow-up questions.
 */
export function useWakeWord(opts: {
  active: boolean;
  /** "Hello HAI" was heard (or `listenNow` was called); HAI is now listening for the question. */
  onWake: () => void;
  onInterim: (text: string) => void;
  onQuestion: (text: string) => void;
  /** Nothing was said after waking up. */
  onTimeout: () => void;
  /** Called when the person says "stop" (for example while HAI is reading a reply aloud). */
  onStop?: () => void;
}) {
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const handlersRef = useRef(opts);
  handlersRef.current = opts;
  const listenNowRef = useRef<(() => boolean) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const finishRef = useRef<(() => void) | null>(null);

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
    let questionTimer: ReturnType<typeof setTimeout> | undefined;
    /** Where the question starts in this session's results, or null while waiting for the wake word. */
    let question: { from: number; skipWake: boolean } | null = null;
    /** Results below this index were already used and are ignored. */
    let ignoreBelow = 0;
    let resultCount = 0;
    /** Words heard so far for the current question. */
    let heardText = "";

    const endQuestion = () => {
      question = null;
      heardText = "";
      ignoreBelow = resultCount;
      clearTimeout(questionTimer);
      setCapturing(false);
    };
    const armTimeout = () => {
      clearTimeout(questionTimer);
      questionTimer = setTimeout(() => {
        endQuestion();
        handlersRef.current.onTimeout();
      }, QUESTION_TIMEOUT_MS);
    };
    const startQuestion = (from: number, skipWake: boolean) => {
      question = { from, skipWake };
      setCapturing(true);
      armTimeout();
      handlersRef.current.onWake();
    };

    listenNowRef.current = () => {
      if (stopped) return false;
      if (!question) startQuestion(resultCount, false);
      return true;
    };
    cancelRef.current = () => {
      if (question) endQuestion();
    };
    finishRef.current = () => {
      if (!question) return;
      const text = heardText;
      endQuestion();
      if (text) handlersRef.current.onQuestion(text);
      else handlersRef.current.onTimeout();
    };

    const begin = () => {
      if (stopped) return;
      const r = new Ctor();
      r.lang = navigator.language || "en-US";
      r.continuous = true;
      r.interimResults = true;
      ignoreBelow = 0;
      resultCount = 0;
      // A session that restarted mid-question keeps listening for that question.
      if (question) question = { from: 0, skipWake: false };
      r.onresult = (event) => {
        resultCount = event.results.length;
        if (!question) {
          for (let i = Math.max(event.resultIndex, ignoreBelow); i < event.results.length; i++) {
            const result = event.results[i]!;
            const transcript = result[0]?.transcript ?? "";
            if (result.isFinal && handlersRef.current.onStop) {
              const said = transcript.toLowerCase().replace(/[.!?,]+/g, "").trim();
              if (STOP_PHRASE.test(said)) {
                ignoreBelow = i + 1;
                handlersRef.current.onStop();
                continue;
              }
            }
            if (findWakeWord(transcript)) {
              startQuestion(i, true);
              break;
            }
          }
        }
        if (!question) return;
        const phrases: HeardPhrase[] = [];
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]!;
          phrases.push({ transcript: result[0]?.transcript ?? "", isFinal: result.isFinal });
        }
        const heard = readQuestionAfterWake(phrases, question.from, question.skipWake);
        if (heard.text) {
          heardText = heard.text;
          armTimeout();
          handlersRef.current.onInterim(heard.text);
        }
        if (heard.done) {
          endQuestion();
          handlersRef.current.onQuestion(heard.text);
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
        restartTimer = setTimeout(begin, RESTART_DELAY_MS * 4);
      }
    };

    begin();
    return () => {
      stopped = true;
      listenNowRef.current = null;
      cancelRef.current = null;
      finishRef.current = null;
      clearTimeout(restartTimer);
      clearTimeout(questionTimer);
      recognition?.abort();
      setListening(false);
      setCapturing(false);
    };
  }, [opts.active]);

  /** Starts listening for a question right away (no wake word). False when not running. */
  const listenNow = useCallback(() => listenNowRef.current?.() ?? false, []);
  /** Stops listening for the current question and goes back to waiting for "Hello HAI". */
  const cancel = useCallback(() => cancelRef.current?.(), []);
  /** Stops listening now and sends whatever was already heard. */
  const finish = useCallback(() => finishRef.current?.(), []);

  return { listening, capturing, error, listenNow, cancel, finish };
}
