import { config } from "../config.ts";

// Global generation queue. The models run on one machine (and Jano swaps the coder/chat
// model on a single GPU), so generations are serialized: at most `config.queueConcurrency`
// run at once (1 by default), the rest wait in FIFO order. This is separate from the
// per-key slot in service.ts (which stops ONE user fanning out parallel turns) — this caps
// the WHOLE machine and reports each waiter's queue position.

const MAX = config.queueConcurrency;

interface Waiter {
  onPosition: (n: number) => void;
  grant: () => void;
}

let active = 0;
const waiters: Waiter[] = [];

function notifyPositions(): void {
  waiters.forEach((w, i) => w.onPosition(i + 1));
}

// Acquire a generation slot. `onPosition` is called with the live queue position:
//   n >= 1  → waiting, n-th in line
//   0       → granted, generating now
// Resolves with a `release()` to call when the generation finishes (in a finally).
export function acquireGenerationSlot(onPosition: (n: number) => void): Promise<() => void> {
  return new Promise((resolve) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      const next = waiters.shift();
      if (next) next.grant();
      notifyPositions();
    };
    const grant = () => {
      active++;
      onPosition(0);
      resolve(release);
    };
    if (active < MAX) {
      grant();
    } else {
      waiters.push({ onPosition, grant });
      onPosition(waiters.length);
    }
  });
}

// How many turns are waiting (not counting the one(s) generating) — for telemetry.
export function queueDepth(): number {
  return waiters.length;
}
