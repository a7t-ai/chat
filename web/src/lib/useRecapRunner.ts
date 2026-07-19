import { useCallback, useRef, useState } from "react";
import { forceRecap as apiForceRecap, type Recap } from "./api";

export interface RecapRunnerOptions {
  // Surface the fresh recap through the "where you left off" card when the model returns one.
  onRecap: (recap: Recap) => void;
  // Nothing to recap (thread too thin / model degraded, forceRecap resolved to null). Non-alarming.
  onEmpty: () => void;
  // The force request threw unexpectedly. A brief, non-alarming "try again" message.
  onError: () => void;
  // Injectable for tests; defaults to the real /recap?force=1 call.
  forceRecap?: (id: string) => Promise<Recap | null>;
}

// Owns the on-demand `/recap` command's loading state + run flow (#37 follow-up). Before this the
// command awaited forceRecap with no feedback, so the user stared at a blank several-second gap
// while Jano generated (the reported "I added /recap and nothing happened"). `recapping` drives the
// visible "Recapping this conversation..." indicator for exactly that window; a ref guards a second
// /recap from firing while one is already generating (a repeat is a no-op, not a double request).
export function useRecapRunner({ onRecap, onEmpty, onError, forceRecap = apiForceRecap }: RecapRunnerOptions) {
  const [recapping, setRecapping] = useState(false);
  // The concurrency guard lives in a ref, not the `recapping` state, so a stale runRecap closure
  // still short-circuits a concurrent call (state reads can lag a synchronous re-invocation).
  const inFlight = useRef(false);
  // Latest callbacks without rebuilding runRecap or disturbing an in-flight run.
  const cb = useRef({ onRecap, onEmpty, onError, forceRecap });
  cb.current = { onRecap, onEmpty, onError, forceRecap };

  const runRecap = useCallback(async (id: string) => {
    if (inFlight.current) return; // a /recap is already generating - ignore the repeat
    inFlight.current = true;
    setRecapping(true);
    try {
      const recap = await cb.current.forceRecap(id);
      if (recap) cb.current.onRecap(recap);
      else cb.current.onEmpty();
    } catch {
      // forceRecap already fails soft to null, but stay defensive: an unexpected throw must still
      // clear the loading state (the finally) and tell the user, never leave a stuck "Recapping...".
      cb.current.onError();
    } finally {
      inFlight.current = false;
      setRecapping(false);
    }
  }, []);

  return { recapping, runRecap };
}
