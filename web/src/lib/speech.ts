// Text-to-speech leg — a minimal wrapper over the Web Speech API's `speechSynthesis`. The
// read-aloud button (Message.tsx) already spoke replies inline; there was no shared helper, so
// Voice mode (#70) extracts that exact code path here and BOTH callers now use it. Kept tiny and
// dependency-free (no new package): it just guards the globals and swallows an unsupported engine
// so a browser without speech synthesis degrades to silence rather than throwing.
//
// There is no read-aloud VOICE preference in the app today (the existing button used the default
// system voice), so this reuses that same default utterance — when a voice pref lands, set it here
// and both callers inherit it.

export function speechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

// Speak `text`, cancelling anything already in flight first (one utterance at a time). `onEnd`
// fires when it finishes AND on an engine error — the caller treats both as "done" so a failed
// utterance never strands the conversational loop. Returns false when speech isn't supported (or
// throws), so the caller can skip straight to the next turn.
export function speak(text: string, opts: { onEnd?: () => void } = {}): boolean {
  if (!speechSupported()) return false;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => opts.onEnd?.();
    utterance.onerror = () => opts.onEnd?.();
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

// Stop any in-progress / queued speech. Safe to call when nothing is speaking or unsupported.
export function cancelSpeech(): void {
  if (!speechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* engine went away mid-call — nothing to cancel */
  }
}
