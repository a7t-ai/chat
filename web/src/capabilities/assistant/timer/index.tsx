import type { ClientCapability } from "../../types";
import { TimerChip } from "./TimerChip";

// Recipes / timers — client capability #2 (the flagship showcase, #10). Chip-only: the marker
//  [[timer:DURATION|LABEL]]  renders as a self-contained inline countdown, so there's no drawer
// Surface and no bulk action. It needs nothing from the server, which is exactly why it also
// works read-only on the public no-login share page. The recipe's shopping list rides the
// existing GFM-task-list + shared-TODO primitive — no capability code needed for that half.
export const timer: ClientCapability = {
  id: "timer",
  pillar: "assistant",
  Chip: TimerChip,
};
