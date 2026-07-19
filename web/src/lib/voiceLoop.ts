// Voice / conversational mode (#70) — the PURE state machine behind the hands-free spoken
// loop. Kept free of any DOM, mic, timer, or network I/O so the whole behavior (every
// transition + the endpoint-timer decision) is exhaustively unit-testable without a browser.
// The React glue (`useVoiceLoop`) is a thin driver over this: it maps each state to a side
// effect (open the mic, run STT, send, speak) and feeds the outcomes back in as events.
//
// The loop: off → idle → listening → transcribing → awaiting → speaking → (idle) → …
//   off          voice mode disabled — no mic, no speech.
//   idle         voice ON, mic not yet capturing (opening, or between turns before it reopens).
//   listening    mic is capturing the user's turn.
//   transcribing audio captured, the STT leg is running.
//   awaiting     the transcript was sent; waiting for the model's answer to finish.
//   speaking     the answer is being read back via TTS.
// When speaking ends (or the user barges in) we return to idle, which reopens the mic — so the
// conversation continues hands-free until the user toggles voice mode off.

import type { MessageKey } from "./i18n/en";

export type VoiceState = "off" | "idle" | "listening" | "transcribing" | "awaiting" | "speaking";

// Events the driver feeds the machine. Text-carrying events (`transcript`, `answered`) let the
// reducer branch on empty-vs-nonempty without the driver having to pre-decide the next state.
export type VoiceEvent =
  | { type: "toggleOn" } // user flipped the composer's Voice toggle on
  | { type: "toggleOff" } // user flipped it off — hard stop everything
  | { type: "micOpen" } // getUserMedia resolved + the recorder started
  | { type: "micFail" } // getUserMedia rejected (denied / no mic) — leave voice mode
  | { type: "endpoint" } // the turn ended: explicit stop press OR the safety timeout fired
  | { type: "transcript"; text: string } // STT returned (may be empty — nothing was said)
  | { type: "transcribeFail" } // the STT leg threw — recover by reopening the mic
  | { type: "answered"; text: string } // the model's turn finished; text is the reply (may be empty)
  | { type: "spoke" } // TTS finished reading the reply (or isn't supported / errored)
  | { type: "bargeIn" }; // user interrupted the reply to take their next turn

// Safety cap: with no client-side VAD in v1 (deferred to #71), a turn ends on an explicit stop
// press. This bound just guarantees an abandoned open mic (user walked away) can't hang the loop
// open forever — it is a backstop, not the primary endpoint.
export const MAX_LISTEN_MS = 30_000;

// The endpoint-timer DECISION, kept pure so it's testable on its own: how long the driver should
// arm the auto-endpoint timer for in the current state (null = don't arm one). Only `listening`
// has a running mic to time out; every other state returns null.
export function endpointDelayMs(state: VoiceState): number | null {
  return state === "listening" ? MAX_LISTEN_MS : null;
}

// The single transition function — total (any invalid event for a state is a no-op that returns
// the state unchanged) and pure. This is the whole behavior contract of voice mode.
export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    // Toggling off is unconditional — from any state it fully stops the loop.
    case "toggleOff":
      return "off";
    // Toggling on only does anything from a stopped machine (the gesture that grants mic access).
    case "toggleOn":
      return state === "off" ? "idle" : state;
    case "micOpen":
      return state === "idle" ? "listening" : state;
    case "micFail":
      return state === "idle" ? "off" : state;
    case "endpoint":
      return state === "listening" ? "transcribing" : state;
    // Empty transcript (silence / a mis-fire) reopens the mic instead of sending a blank turn.
    case "transcript":
      return state === "transcribing" ? (event.text.trim() ? "awaiting" : "idle") : state;
    case "transcribeFail":
      return state === "transcribing" ? "idle" : state;
    // An empty answer has nothing to read back — skip speaking and reopen the mic.
    case "answered":
      return state === "awaiting" ? (event.text.trim() ? "speaking" : "idle") : state;
    case "spoke":
      return state === "speaking" ? "idle" : state;
    case "bargeIn":
      return state === "speaking" ? "idle" : state;
    default:
      return state;
  }
}

// Voice mode is "active" (the toggle shows on) in every state except off.
export function voiceActive(state: VoiceState): boolean {
  return state !== "off";
}

// The mic is capturing only while listening (drives disabling the one-shot dictation mic).
export function voiceMicOpen(state: VoiceState): boolean {
  return state === "listening";
}

// The i18n key for the current phase, shown in the status pill + announced to screen readers.
// `idle` reads as "Listening" because it's the sub-second gap while the mic (re)opens.
export function voiceStatusKey(state: VoiceState): MessageKey | null {
  switch (state) {
    case "idle":
    case "listening":
      return "voice.listening";
    case "transcribing":
      return "voice.transcribing";
    case "awaiting":
      return "voice.thinking";
    case "speaking":
      return "voice.speaking";
    default:
      return null;
  }
}

// The i18n key for what tapping the status pill does in the current phase (null = not actionable,
// so the pill renders as a plain status rather than a button). Listening → end the turn now;
// speaking → interrupt the reply and take the next turn.
export function voiceActionKey(state: VoiceState): MessageKey | null {
  switch (state) {
    case "listening":
      return "voice.stopAndSend";
    case "speaking":
      return "voice.interrupt";
    default:
      return null;
  }
}
