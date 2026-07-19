import { Pause, Play, RotateCcw, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePreferences } from "../../../lib/preferences";
import { type ChimeHandle, notifyDone, playChime, requestNotifyPermission, unlockAudio } from "./alarm";
import { formatClock, parseTimer } from "./timer";

// Inline chip rendered for a  [[timer:DURATION|LABEL]]  marker on a recipe step. It's a
// self-contained countdown: click to start/pause, it counts down, and announces "done" — no
// server, no drawer, no shared state, so it works identically on the private chat AND on the
// public no-login share page (each viewer runs their own timer). A malformed marker degrades to
// plain text so it can never break the message.
export function TimerChip({ payload }: { payload: string; open?: () => void }) {
  const parsed = parseTimer(payload);
  if (!parsed) return <span className="timer-raw">{payload}</span>;
  // Key on the payload so an edited/re-rendered marker with a different duration re-inits cleanly.
  return <Countdown key={`${parsed.seconds}:${parsed.label}`} seconds={parsed.seconds} label={parsed.label} />;
}

function Countdown({ seconds, label }: { seconds: number; label: string }) {
  const [remaining, setRemaining] = useState(seconds);
  const [running, setRunning] = useState(false);
  const soundOn = usePreferences().behavior.timerSound;
  // Absolute wall-clock end instant while running (null when paused/stopped). Computing remaining
  // from this each tick keeps the countdown accurate regardless of interval jitter or a throttled
  // background tab.
  const endsAtRef = useRef<number | null>(null);
  // The active chime, so any interaction (and unmount) can silence it.
  const chimeRef = useRef<ChimeHandle | null>(null);
  // Guards the "fire each channel once per completion" rule (re-armed on a fresh start/reset).
  const firedRef = useRef(false);

  function stopChime() {
    chimeRef.current?.stop();
    chimeRef.current = null;
  }

  useEffect(() => {
    if (!running) return;
    const tick = () => {
      const end = endsAtRef.current;
      if (end === null) return;
      const rem = Math.max(0, Math.round((end - Date.now()) / 1000));
      setRemaining(rem);
      if (rem <= 0) {
        endsAtRef.current = null;
        setRunning(false);
      }
    };
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [running]);

  const done = remaining <= 0;
  const name = label || "Timer";

  // Alert exactly once when the countdown crosses to done: chime (unless muted), plus an OS
  // notification when the tab is hidden. The visual pulse is pure CSS on the .done class. Reads
  // the live mute pref so a change between Start and completion is honored.
  useEffect(() => {
    if (!done) {
      firedRef.current = false;
      return;
    }
    if (firedRef.current) return;
    firedRef.current = true;
    if (soundOn) {
      stopChime();
      chimeRef.current = playChime();
    }
    notifyDone(`${name} done`);
  }, [done, soundOn, name]);

  // Silence a ringing chime if the chip unmounts mid-alarm.
  useEffect(() => () => stopChime(), []);

  function toggle() {
    stopChime(); // any interaction silences a ringing alarm
    if (running) {
      // Pause: freeze on the last shown value (endsAt cleared; `remaining` already reflects it).
      endsAtRef.current = null;
      setRunning(false);
      return;
    }
    // Start / resume / restart-when-done. This tap is the user gesture we ride to unlock audio and
    // (once) ask for notification permission, so the end-of-timer chime/notification can fire later
    // — even minutes on and even if the tab is backgrounded by then.
    unlockAudio();
    requestNotifyPermission();
    const base = done ? seconds : remaining;
    if (done) setRemaining(seconds);
    endsAtRef.current = Date.now() + base * 1000;
    setRunning(true);
  }

  function reset() {
    stopChime();
    endsAtRef.current = null;
    setRunning(false);
    setRemaining(seconds);
  }

  const pristine = !running && remaining === seconds;
  const toggleLabel = running ? `Pause ${name}` : done ? `Restart ${name}` : `Start ${name}`;

  return (
    <span className={`cap-chip timer-chip${running ? " running" : ""}${done ? " done" : ""}`}>
      <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
      {label && <span className="timer-label">{label}</span>}
      <button type="button" className="timer-toggle" onClick={toggle} aria-label={toggleLabel} title={toggleLabel}>
        {running ? (
          <Pause size={14} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Play size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
        )}
        <span className="timer-clock">{done ? "Done" : formatClock(remaining)}</span>
      </button>
      {!pristine && (
        <button type="button" className="timer-reset" onClick={reset} aria-label={`Reset ${name}`} title={`Reset ${name}`}>
          <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      {/* Announced once when the countdown finishes (only rendered while done, so no per-second spam). */}
      {done && (
        <span role="status" className="timer-done-note">
          {name} done
        </span>
      )}
    </span>
  );
}
