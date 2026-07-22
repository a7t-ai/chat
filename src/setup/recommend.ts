// Pure model-recommendation core for `bun run setup`. Kept free of I/O so it is exhaustively
// unit-tested: the wizard shells out to collect raw `df` / `nvidia-smi` / `sysctl` text, then hands
// those strings here for parsing, and hands the resulting numbers to recommend(). No hardware needed
// to test any of it.

import { SETUP_CATALOG, type SetupModel } from "./catalog.ts";

// What the wizard learned about the machine. `vramGB` is null on Apple Silicon (unified memory, so
// `ramGB` is the real budget) or when no discrete GPU / VRAM figure was found.
export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  ramGB: number;
  cores: number;
  chip: string;
  vramGB: number | null;
  diskFreeGB: number;
}

// The memory the model actually runs in: VRAM on a discrete GPU, else unified/system RAM.
export function budgetFor(hw: Pick<Hardware, "ramGB" | "vramGB">): number {
  return hw.vramGB ?? hw.ramGB;
}

// Rank the catalog by what this machine can actually run, best (largest that fits) first. Rule of
// thumb for a GGUF: the weights file should be at most ~60% of the memory budget (leaving room for
// the KV cache + OS/app), the model needs its minimum budget, and the download plus ~5 GB headroom
// must fit on disk.
export function recommend(hw: Pick<Hardware, "ramGB" | "vramGB" | "diskFreeGB">): SetupModel[] {
  const budget = budgetFor(hw);
  return SETUP_CATALOG.filter(
    (m) => budget >= m.minBudgetGB && m.sizeGB <= budget * 0.6 && m.sizeGB + 5 <= hw.diskFreeGB,
  ).sort((a, b) => b.sizeGB - a.sizeGB);
}

// Parse macOS `df -g <path>` free space (the "Available" column, GB). Output looks like:
//   Filesystem  1G-blocks  Used  Available  Capacity  iused  ...  Mounted on
//   /dev/disk3s5     1000    400        590       41%   ...            /
// Returns the Available column (index 3) of the data row, or 0 if it can't be parsed.
export function parseMacDfGb(out: string): number {
  const rows = out.trim().split("\n");
  const data = rows[1]; // second line is the first (only) filesystem row
  if (!data) return 0;
  const cols = data.trim().split(/\s+/);
  const avail = cols[3];
  const n = avail ? Number.parseInt(avail, 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// Parse Linux `df -BG --output=avail <path>` free space (GB). Output looks like:
//   Avail
//    590G
// Returns the numeric GB of the data row, or 0 if it can't be parsed.
export function parseLinuxDfGb(out: string): number {
  const rows = out.trim().split("\n");
  const data = rows[1];
  if (!data) return 0;
  const n = Number.parseInt(data.trim().replace(/G$/i, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

// Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits` (total VRAM in MiB) into
// whole GB. Returns null when there is no NVIDIA GPU (empty/garbage output) so the caller falls back
// to system RAM as the budget.
export function parseNvidiaSmiGb(out: string): number | null {
  const first = out.trim().split("\n")[0];
  if (!first) return null;
  const mib = Number.parseInt(first.trim(), 10);
  if (!Number.isFinite(mib) || mib <= 0) return null;
  return Math.round(mib / 1024);
}
