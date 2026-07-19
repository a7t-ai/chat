import { describe, expect, test } from "vitest";
import {
  endpointDelayMs,
  MAX_LISTEN_MS,
  type VoiceEvent,
  type VoiceState,
  voiceActionKey,
  voiceActive,
  voiceMicOpen,
  voiceReducer,
  voiceStatusKey,
} from "./voiceLoop";

const ALL_STATES: VoiceState[] = ["off", "idle", "listening", "transcribing", "awaiting", "speaking"];

describe("voiceReducer — the conversational loop", () => {
  test("toggleOn only starts the loop from off (idle); a no-op everywhere else", () => {
    expect(voiceReducer("off", { type: "toggleOn" })).toBe("idle");
    for (const s of ALL_STATES.filter((s) => s !== "off")) {
      expect(voiceReducer(s, { type: "toggleOn" })).toBe(s);
    }
  });

  test("toggleOff hard-stops from every state", () => {
    for (const s of ALL_STATES) {
      expect(voiceReducer(s, { type: "toggleOff" })).toBe("off");
    }
  });

  test("idle → listening on micOpen; micFail leaves voice mode", () => {
    expect(voiceReducer("idle", { type: "micOpen" })).toBe("listening");
    expect(voiceReducer("idle", { type: "micFail" })).toBe("off");
  });

  test("micOpen / micFail are no-ops outside idle", () => {
    for (const s of ALL_STATES.filter((s) => s !== "idle")) {
      expect(voiceReducer(s, { type: "micOpen" })).toBe(s);
      expect(voiceReducer(s, { type: "micFail" })).toBe(s);
    }
  });

  test("listening → transcribing on endpoint (stop press / timeout); no-op elsewhere", () => {
    expect(voiceReducer("listening", { type: "endpoint" })).toBe("transcribing");
    for (const s of ALL_STATES.filter((s) => s !== "listening")) {
      expect(voiceReducer(s, { type: "endpoint" })).toBe(s);
    }
  });

  test("transcript with speech → awaiting; empty transcript reopens the mic (idle)", () => {
    expect(voiceReducer("transcribing", { type: "transcript", text: "hello there" })).toBe("awaiting");
    expect(voiceReducer("transcribing", { type: "transcript", text: "   " })).toBe("idle");
    expect(voiceReducer("transcribing", { type: "transcript", text: "" })).toBe("idle");
  });

  test("transcript is a no-op when not transcribing", () => {
    for (const s of ALL_STATES.filter((s) => s !== "transcribing")) {
      expect(voiceReducer(s, { type: "transcript", text: "hi" })).toBe(s);
    }
  });

  test("transcribeFail recovers to idle only from transcribing", () => {
    expect(voiceReducer("transcribing", { type: "transcribeFail" })).toBe("idle");
    for (const s of ALL_STATES.filter((s) => s !== "transcribing")) {
      expect(voiceReducer(s, { type: "transcribeFail" })).toBe(s);
    }
  });

  test("answered with text → speaking; an empty answer reopens the mic (idle)", () => {
    expect(voiceReducer("awaiting", { type: "answered", text: "the answer" })).toBe("speaking");
    expect(voiceReducer("awaiting", { type: "answered", text: "  " })).toBe("idle");
    expect(voiceReducer("awaiting", { type: "answered", text: "" })).toBe("idle");
  });

  test("answered is a no-op when not awaiting", () => {
    for (const s of ALL_STATES.filter((s) => s !== "awaiting")) {
      expect(voiceReducer(s, { type: "answered", text: "x" })).toBe(s);
    }
  });

  test("spoke and bargeIn both return to idle only from speaking", () => {
    expect(voiceReducer("speaking", { type: "spoke" })).toBe("idle");
    expect(voiceReducer("speaking", { type: "bargeIn" })).toBe("idle");
    for (const s of ALL_STATES.filter((s) => s !== "speaking")) {
      expect(voiceReducer(s, { type: "spoke" })).toBe(s);
      expect(voiceReducer(s, { type: "bargeIn" })).toBe(s);
    }
  });

  test("an unknown event leaves the state untouched (total reducer)", () => {
    expect(voiceReducer("listening", { type: "bogus" } as unknown as VoiceEvent)).toBe("listening");
  });

  test("a full hands-free cycle: off → … → speaking → idle (reopens the mic)", () => {
    let s: VoiceState = "off";
    s = voiceReducer(s, { type: "toggleOn" }); // → idle
    s = voiceReducer(s, { type: "micOpen" }); // → listening
    s = voiceReducer(s, { type: "endpoint" }); // → transcribing
    s = voiceReducer(s, { type: "transcript", text: "what time is it" }); // → awaiting
    s = voiceReducer(s, { type: "answered", text: "it is noon" }); // → speaking
    s = voiceReducer(s, { type: "spoke" }); // → idle (loops)
    expect(s).toBe("idle");
  });
});

describe("endpointDelayMs — the endpoint-timer decision", () => {
  test("arms the safety timeout only while listening", () => {
    expect(endpointDelayMs("listening")).toBe(MAX_LISTEN_MS);
    for (const s of ALL_STATES.filter((s) => s !== "listening")) {
      expect(endpointDelayMs(s)).toBeNull();
    }
  });
});

describe("view helpers", () => {
  test("voiceActive is true in every state except off", () => {
    expect(voiceActive("off")).toBe(false);
    for (const s of ALL_STATES.filter((s) => s !== "off")) {
      expect(voiceActive(s)).toBe(true);
    }
  });

  test("voiceMicOpen is true only while listening", () => {
    expect(voiceMicOpen("listening")).toBe(true);
    for (const s of ALL_STATES.filter((s) => s !== "listening")) {
      expect(voiceMicOpen(s)).toBe(false);
    }
  });

  test("voiceStatusKey maps each phase to a label (off → null)", () => {
    expect(voiceStatusKey("off")).toBeNull();
    expect(voiceStatusKey("idle")).toBe("voice.listening");
    expect(voiceStatusKey("listening")).toBe("voice.listening");
    expect(voiceStatusKey("transcribing")).toBe("voice.transcribing");
    expect(voiceStatusKey("awaiting")).toBe("voice.thinking");
    expect(voiceStatusKey("speaking")).toBe("voice.speaking");
  });

  test("voiceActionKey is set only for the actionable phases", () => {
    expect(voiceActionKey("listening")).toBe("voice.stopAndSend");
    expect(voiceActionKey("speaking")).toBe("voice.interrupt");
    for (const s of ["off", "idle", "transcribing", "awaiting"] as VoiceState[]) {
      expect(voiceActionKey(s)).toBeNull();
    }
  });
});
