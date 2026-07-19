// End-of-timer alerting for the cooking-timer chip (#130). Two self-contained channels:
//
//   1. A synthesized WebAudio chime — no asset, no network — so it works IDENTICALLY on the
//      private chat AND the no-login public share page. Browsers only allow audio after a user
//      gesture, so `unlockAudio()` is called on the Start tap; the resulting AudioContext stays
//      usable to fire the tone minutes later, even on a throttled background tab.
//   2. An OS notification for a backgrounded tab, permission requested contextually on that same
//      first Start (never on page load).
//
// Every browser-API touch is feature-detected and wrapped so a missing/blocked/oddly-behaved API
// degrades SILENTLY — the alarm never throws into the countdown UI. Kept side-effect-free at import
// time (the singleton context is created lazily on the gesture) so it's safe to unit-test.

// The chime rings a short, bounded pattern so an unattended timer doesn't ring forever; any timer
// interaction (pause/reset/restart) stops it early via the returned handle.
const RING_INTERVAL_MS = 850;
const MAX_RINGS = 6;

interface WebkitWindow {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

// The single shared context — one per page, resumed (not recreated) on each Start so we never leak
// contexts and the tone stays authorized for the life of the tab.
let ctx: AudioContext | null = null;

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as WebkitWindow;
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

// Create-or-resume the shared AudioContext on a user gesture (the Start tap). Idempotent and
// failure-tolerant: a hardware/permissions hiccup just leaves the feature silent.
export function unlockAudio(): void {
  const Ctor = audioContextCtor();
  if (!Ctor) return;
  try {
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

export interface ChimeHandle {
  stop(): void;
}

const SILENT: ChimeHandle = { stop() {} };

// One two-tone "ding-dong" beep with a short click-free envelope. Tracks the oscillator in `live`
// so the handle can stop it immediately on interaction.
function emitBeep(c: AudioContext, live: Set<OscillatorNode>): void {
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, t); // A5
  osc.frequency.setValueAtTime(1174, t + 0.14); // ~D6
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.36);
  live.add(osc);
  osc.onended = () => live.delete(osc);
}

// Play the bounded chime pattern. Returns a handle whose stop() silences it at once; no-ops (and
// returns a stopped handle) when the context was never unlocked or the audio call throws.
export function playChime(): ChimeHandle {
  const c = ctx;
  if (!c) return SILENT;
  try {
    // A backgrounded tab can suspend the context between Start and completion — nudge it awake.
    if (c.state === "suspended") void c.resume();
  } catch {
    return SILENT;
  }

  const live = new Set<OscillatorNode>();
  let rings = 0;
  let iv: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (iv !== null) {
      clearInterval(iv);
      iv = null;
    }
    for (const osc of live) {
      try {
        osc.stop();
      } catch {
        /* already stopped/ended */
      }
    }
    live.clear();
  };

  const ring = (): void => {
    rings++;
    try {
      emitBeep(c, live);
    } catch {
      /* transient audio failure — keep the countdown alive */
    }
    if (rings >= MAX_RINGS) stop();
  };

  ring(); // fire the first ring immediately at completion
  if (rings < MAX_RINGS) iv = setInterval(ring, RING_INTERVAL_MS);
  return { stop };
}

function notificationApi(): typeof Notification | null {
  if (typeof globalThis === "undefined") return null;
  const N = (globalThis as { Notification?: typeof Notification }).Notification;
  return typeof N === "function" ? N : null;
}

// Ask for OS-notification permission on the FIRST timer Start (a user gesture) — never on load.
// No-ops when unsupported or already decided (granted/denied). Failure-tolerant.
export function requestNotifyPermission(): void {
  const N = notificationApi();
  if (!N) return;
  try {
    if (N.permission === "default") void N.requestPermission();
  } catch {
    /* some browsers throw on the legacy callback form — ignore */
  }
}

// Raise an OS notification for a finished timer, but ONLY when the tab is hidden (a visible timer
// already shows its Done state + chime). No-ops without granted permission or an available API.
// Returns whether it fired (for tests). Failure-tolerant.
export function notifyDone(label: string): boolean {
  const N = notificationApi();
  if (!N) return false;
  if (typeof document !== "undefined" && !document.hidden) return false;
  try {
    if (N.permission !== "granted") return false;
    new N(label);
    return true;
  } catch {
    return false;
  }
}
