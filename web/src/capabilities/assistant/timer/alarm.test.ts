import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// alarm.ts is the self-contained end-of-timer alerting for the recipe timer chip (#130): a
// synthesized WebAudio chime + an OS notification, both feature-detected and failure-tolerant. It
// holds a module-level AudioContext singleton, so each test re-imports the module fresh
// (vi.resetModules) to start from a clean, un-unlocked state. jsdom has neither AudioContext nor
// Notification, so we stub minimal fakes.

class FakeOsc {
  type = "";
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
  onended: (() => void) | null = null;
}
class FakeGain {
  gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
}
class FakeCtx {
  static instances: FakeCtx[] = [];
  state: "running" | "suspended" = "running";
  currentTime = 0;
  destination = {};
  oscillators: FakeOsc[] = [];
  resume = vi.fn(() => {
    this.state = "running";
    return Promise.resolve();
  });
  createOscillator = () => {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o as unknown as OscillatorNode;
  };
  createGain = () => new FakeGain() as unknown as GainNode;
  constructor() {
    FakeCtx.instances.push(this);
  }
}

// A Notification stand-in whose static permission/requestPermission we can drive per test.
function makeNotification(permission: NotificationPermission) {
  const ctor = vi.fn(function (this: unknown, title: string) {
    (ctor as unknown as { lastTitle?: string }).lastTitle = title;
  }) as unknown as typeof Notification & { lastTitle?: string };
  (ctor as unknown as { permission: NotificationPermission }).permission = permission;
  (ctor as unknown as { requestPermission: () => Promise<NotificationPermission> }).requestPermission = vi.fn(() =>
    Promise.resolve(permission),
  );
  return ctor;
}

beforeEach(() => {
  vi.resetModules();
  FakeCtx.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Restore visibility if a test overrode it.
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

async function load() {
  return import("./alarm");
}

describe("unlockAudio", () => {
  test("creates a single context and resumes it when suspended", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio } = await load();
    unlockAudio();
    unlockAudio(); // idempotent — no second context
    expect(FakeCtx.instances.length).toBe(1);
  });

  test("resumes a suspended context on a later gesture", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    ctx.state = "suspended";
    unlockAudio();
    expect(ctx.resume).toHaveBeenCalled();
  });

  test("falls back to webkitAudioContext", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio } = await load();
    unlockAudio();
    expect(FakeCtx.instances.length).toBe(1);
  });

  test("no-ops silently when no AudioContext is available", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { unlockAudio, playChime } = await load();
    expect(() => unlockAudio()).not.toThrow();
    // Without a context, the chime is silent.
    const handle = playChime();
    expect(() => handle.stop()).not.toThrow();
  });

  test("a throwing constructor is swallowed", async () => {
    const Boom = vi.fn(() => {
      throw new Error("no audio hw");
    });
    vi.stubGlobal("AudioContext", Boom as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    expect(() => unlockAudio()).not.toThrow();
    expect(playChime()).toBeDefined(); // returns the silent handle
  });
});

describe("playChime", () => {
  test("returns a silent handle before any unlock", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { playChime } = await load();
    const handle = playChime();
    expect(FakeCtx.instances.length).toBe(0); // playChime never creates a context itself
    expect(() => handle.stop()).not.toThrow();
  });

  test("emits the first ring immediately and repeats on the interval, bounded", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    const handle = playChime();
    expect(ctx.oscillators.length).toBe(1); // rang immediately
    vi.advanceTimersByTime(850 * 3);
    expect(ctx.oscillators.length).toBe(4);
    // Bounded: keep advancing well past MAX_RINGS — it stops on its own.
    vi.advanceTimersByTime(850 * 20);
    expect(ctx.oscillators.length).toBe(6);
    handle.stop();
  });

  test("stop() clears the interval and stops live oscillators", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    const handle = playChime();
    const first = ctx.oscillators[0]!;
    handle.stop();
    expect(first.stop).toHaveBeenCalled();
    // No further rings after stop.
    vi.advanceTimersByTime(850 * 5);
    expect(ctx.oscillators.length).toBe(1);
  });

  test("resumes a context that suspended between Start and completion", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    ctx.state = "suspended";
    playChime();
    expect(ctx.resume).toHaveBeenCalled();
  });

  test("returns a silent handle when resume throws", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    ctx.state = "suspended";
    ctx.resume = vi.fn(() => {
      throw new Error("resume failed");
    });
    const handle = playChime();
    expect(ctx.oscillators.length).toBe(0); // never rang
    expect(() => handle.stop()).not.toThrow();
  });

  test("a stopped oscillator throwing on stop() is swallowed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    const handle = playChime();
    ctx.oscillators[0]!.stop = vi.fn(() => {
      throw new Error("already stopped");
    });
    expect(() => handle.stop()).not.toThrow();
  });

  test("onended prunes a finished oscillator from the live set", async () => {
    vi.stubGlobal("AudioContext", FakeCtx as unknown as typeof AudioContext);
    const { unlockAudio, playChime } = await load();
    unlockAudio();
    const ctx = FakeCtx.instances[0]!;
    const handle = playChime();
    const osc = ctx.oscillators[0]!;
    // emitBeep already schedules a natural stop(t+0.36); capture that baseline.
    const scheduled = osc.stop.mock.calls.length;
    osc.onended?.(); // simulate the beep finishing → pruned from the live set
    handle.stop();
    expect(osc.stop.mock.calls.length).toBe(scheduled); // pruned, so stop() didn't touch it again
  });
});

describe("requestNotifyPermission", () => {
  test("requests only when permission is still default", async () => {
    const N = makeNotification("default");
    vi.stubGlobal("Notification", N);
    const { requestNotifyPermission } = await load();
    requestNotifyPermission();
    expect((N as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).toHaveBeenCalled();
  });

  test("does not re-prompt once decided", async () => {
    const N = makeNotification("granted");
    vi.stubGlobal("Notification", N);
    const { requestNotifyPermission } = await load();
    requestNotifyPermission();
    expect((N as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission).not.toHaveBeenCalled();
  });

  test("no-ops without the Notification API", async () => {
    vi.stubGlobal("Notification", undefined);
    const { requestNotifyPermission } = await load();
    expect(() => requestNotifyPermission()).not.toThrow();
  });

  test("swallows a throwing requestPermission", async () => {
    const N = makeNotification("default");
    (N as unknown as { requestPermission: () => Promise<NotificationPermission> }).requestPermission = vi.fn(() => {
      throw new Error("legacy callback form");
    });
    vi.stubGlobal("Notification", N);
    const { requestNotifyPermission } = await load();
    expect(() => requestNotifyPermission()).not.toThrow();
  });
});

describe("notifyDone", () => {
  function setHidden(hidden: boolean) {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  }

  test("fires with the label when hidden and granted", async () => {
    setHidden(true);
    const N = makeNotification("granted");
    vi.stubGlobal("Notification", N);
    const { notifyDone } = await load();
    expect(notifyDone("Pasta done")).toBe(true);
    expect((N as unknown as { lastTitle?: string }).lastTitle).toBe("Pasta done");
  });

  test("does not fire while the tab is visible", async () => {
    setHidden(false);
    const N = makeNotification("granted");
    vi.stubGlobal("Notification", N);
    const { notifyDone } = await load();
    expect(notifyDone("Pasta done")).toBe(false);
    expect(N).not.toHaveBeenCalled();
  });

  test("does not fire without granted permission", async () => {
    setHidden(true);
    const N = makeNotification("denied");
    vi.stubGlobal("Notification", N);
    const { notifyDone } = await load();
    expect(notifyDone("Pasta done")).toBe(false);
  });

  test("no-ops without the Notification API", async () => {
    vi.stubGlobal("Notification", undefined);
    const { notifyDone } = await load();
    expect(notifyDone("Pasta done")).toBe(false);
  });

  test("swallows a throwing Notification constructor", async () => {
    setHidden(true);
    const N = vi.fn(() => {
      throw new Error("blocked");
    }) as unknown as typeof Notification;
    (N as unknown as { permission: NotificationPermission }).permission = "granted";
    vi.stubGlobal("Notification", N);
    const { notifyDone } = await load();
    expect(notifyDone("Pasta done")).toBe(false);
  });
});
