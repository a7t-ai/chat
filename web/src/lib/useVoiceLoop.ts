// Voice / conversational mode (#70) — the thin React driver over the pure `voiceLoop` machine.
// It owns the imperative, non-testable-in-a-reducer pieces (the mic recorder, the endpoint timer,
// the TTS engine) and wires each STATE to its side effect, feeding outcomes back as events. All
// the decisions live in `voiceReducer` / `endpointDelayMs`; this file is just plumbing.
//
// Reuse: the speech-to-text leg posts through the SAME `transcribe()` client (→ `/api/transcribe`
// → the whisper service) the one-shot dictation mic already used; the text-to-speech leg uses the
// shared `speech.ts` helper extracted from the read-aloud button. The mic capture mirrors the
// existing composer recorder (getUserMedia + MediaRecorder).

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { MessageKey } from "./i18n/en";
import { cancelSpeech, speak } from "./speech";
import { endpointDelayMs, type VoiceState, voiceReducer } from "./voiceLoop";

export interface UseVoiceLoopOptions {
  // A turn is streaming (the parent's `sending`). The loop waits for its true→false edge before
  // reading the reply back, so it speaks a FINISHED answer, never a half-streamed one.
  busy: boolean;
  // The latest final assistant text, read at answer time (kept in a ref so no stale closure).
  getReply: () => string;
  // Drop a transcript into the normal send pipeline — identical to the user having typed it.
  send: (text: string) => void;
  // The STT leg: post recorded audio, get a transcript back (injected so it's trivially mockable).
  transcribe: (blob: Blob) => Promise<string>;
  // Surface a mic / transcription failure to the composer (null clears it).
  onNotice: (key: MessageKey | null) => void;
}

export interface VoiceLoop {
  state: VoiceState;
  toggle: () => void; // flip voice mode on/off (the user's gesture)
  stopTurn: () => void; // end the current turn (listening) or interrupt the reply (speaking)
}

export function useVoiceLoop(opts: UseVoiceLoopOptions): VoiceLoop {
  const [state, dispatch] = useReducer(voiceReducer, "off" as VoiceState);

  // Latest values, read from async callbacks + timers without re-arming effects on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const stateRef = useRef(state);
  stateRef.current = state;

  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextRef = useRef(""); // transcript awaiting send
  const replyTextRef = useRef(""); // answer awaiting speech
  const sawBusyRef = useRef(false); // observed the turn go busy, so its !busy is the finish edge

  // Stop the mic hard, WITHOUT transcribing (used on toggle-off / unmount). Detaching `onstop`
  // first is what distinguishes it from a normal turn end (which relies on onstop → transcribe).
  const hardStopMic = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        /* already inactive */
      }
    }
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
  }, []);

  // The endpoint → STT leg: release the mic, bundle the audio, transcribe, and feed the result
  // back as a `transcript` event (the reducer decides send-vs-reopen on empty).
  const finishRecording = useCallback(async (rec: MediaRecorder) => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    recRef.current = null;
    const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
    try {
      const text = await optsRef.current.transcribe(blob);
      if (stateRef.current === "off") return; // toggled off mid-STT — drop it
      pendingTextRef.current = text;
      dispatch({ type: "transcript", text });
    } catch {
      if (stateRef.current === "off") return;
      optsRef.current.onNotice("composer.transcribeError");
      dispatch({ type: "transcribeFail" });
    }
  }, []);

  // Open the mic + start recording (on entering `idle`). Dispatches micOpen on success so the
  // machine advances to `listening`, or micFail so it leaves voice mode with a clear notice.
  const openMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (stateRef.current === "off") {
        // Toggled off while the permission prompt was up — release and abandon.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        void finishRecording(rec);
      };
      recRef.current = rec;
      rec.start();
      optsRef.current.onNotice(null);
      dispatch({ type: "micOpen" });
    } catch {
      optsRef.current.onNotice("composer.micError");
      dispatch({ type: "micFail" });
    }
  }, [finishRecording]);

  // idle → open the mic for the next turn.
  useEffect(() => {
    if (state === "idle") void openMic();
  }, [state, openMic]);

  // listening → arm the safety-timeout backstop (the endpoint decision lives in the pure module).
  useEffect(() => {
    const delay = endpointDelayMs(state);
    if (delay == null) return;
    timerRef.current = setTimeout(() => dispatch({ type: "endpoint" }), delay);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [state]);

  // transcribing → stop the recorder; its `onstop` runs the STT leg (finishRecording).
  useEffect(() => {
    if (state === "transcribing") {
      try {
        recRef.current?.stop();
      } catch {
        /* recorder already inactive */
      }
    }
  }, [state]);

  // awaiting → hand the transcript to the send pipeline exactly once, and reset the busy tracker.
  useEffect(() => {
    if (state === "awaiting") {
      sawBusyRef.current = false;
      optsRef.current.send(pendingTextRef.current);
      pendingTextRef.current = "";
    }
  }, [state]);

  // awaiting → watch the turn's busy edge: once it went busy and then settles, the answer is
  // final — capture it and move to speaking (or reopen the mic if there's nothing to read back).
  useEffect(() => {
    if (state !== "awaiting") return;
    if (optsRef.current.busy) {
      sawBusyRef.current = true;
      return;
    }
    if (sawBusyRef.current) {
      const reply = optsRef.current.getReply();
      replyTextRef.current = reply;
      dispatch({ type: "answered", text: reply });
    }
  }, [state, opts.busy]);

  // speaking → read the reply aloud; when it ends (or isn't supported) advance to the next turn.
  useEffect(() => {
    if (state !== "speaking") return;
    const spoken = speak(replyTextRef.current, {
      onEnd: () => {
        if (stateRef.current === "speaking") dispatch({ type: "spoke" });
      },
    });
    if (!spoken) dispatch({ type: "spoke" }); // no TTS engine — skip straight to listening
    return () => cancelSpeech();
  }, [state]);

  // off → tear the whole loop down (idempotent: a no-op on the initial mounted-off state).
  useEffect(() => {
    if (state === "off") {
      hardStopMic();
      cancelSpeech();
    }
  }, [state, hardStopMic]);

  // Unmount (navigate away / component gone) — never leave the mic or speech running.
  useEffect(
    () => () => {
      hardStopMic();
      cancelSpeech();
    },
    [hardStopMic],
  );

  const toggle = useCallback(() => {
    dispatch(stateRef.current === "off" ? { type: "toggleOn" } : { type: "toggleOff" });
  }, []);

  // The status-pill tap: end the turn while listening, or barge in while the reply is speaking.
  const stopTurn = useCallback(() => {
    const s = stateRef.current;
    if (s === "listening") dispatch({ type: "endpoint" });
    else if (s === "speaking") dispatch({ type: "bargeIn" });
  }, []);

  return { state, toggle, stopTurn };
}
