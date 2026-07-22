// Guided install wizard for a7t.chat: `bun run setup`.
//
// One command that detects the machine, recommends a local GGUF model it can actually run, downloads
// it from Hugging Face, serves it with llama.cpp, wires .env, and verifies a clean streaming turn.
// Everything persistent is confirmed first and can be skipped -- someone who just wants to try it
// declines the boot service and runs the server in the foreground; someone setting up a home box
// says yes and gets a service that survives reboots.
//
// Zero new dependencies: Bun's built-in prompt()/confirm(), Bun.spawn / Bun.which for shell-outs,
// fetch for the Hugging Face API + the verify smoke test. The pure recommendation/parse/verify core
// lives in ../src/setup (unit-tested); this file is the interactive I/O shell.
//
//   bun run setup                         # interactive
//   bun run setup --yes --model qwen2.5-7b  # non-interactive (CI/scripts): accept every default
//   bun run setup --dry-run               # detect + recommend only, no downloads or edits
//   bun run setup --help

import os from "node:os";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { hfResolveUrl, SETUP_CATALOG, setupModelById, type SetupModel } from "../src/setup/catalog.ts";
import {
  budgetFor,
  type Hardware,
  parseLinuxDfGb,
  parseMacDfGb,
  parseNvidiaSmiGb,
  recommend,
} from "../src/setup/recommend.ts";
import { isStrayRoleToken } from "../src/setup/verify.ts";

// --- tiny ANSI + arg helpers (no color/prompt dependency) --------------------------------------
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const YES = process.argv.includes("--yes");
const DRY = process.argv.includes("--dry-run");
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
// In --yes mode we never block on stdin: confirms take their default, prompts take their default.
function ask(question: string, def: boolean): boolean {
  if (YES) return def;
  return confirm(`${question}${def ? " [Y/n]" : " [y/N]"}`);
}
function askStr(question: string, def: string): string {
  if (YES) return def;
  const a = prompt(question, def);
  return a && a.trim() ? a.trim() : def;
}
function step(n: number, title: string) {
  console.log(`\n${bold(`${n}.`)} ${bold(title)}`);
}

// --- shell-out helpers (argv arrays -> no shell escaping surface) -------------------------------
async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { stdio: ["ignore", "pipe", "pipe"] });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, out: out.trim() };
}
async function inherit(argv: string[], extraEnv?: Record<string, string>): Promise<number> {
  const p = Bun.spawn(argv, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...(process.env as Record<string, string>), ...extraEnv },
  });
  return await p.exited;
}

// --- hardware detection (feeds the pure parsers/recommender) ------------------------------------
async function detectHardware(): Promise<Hardware> {
  const platform = os.platform();
  const arch = os.arch();
  const ramGB = Math.round(os.totalmem() / 1e9);
  const cores = os.cpus().length;
  let chip = os.cpus()[0]?.model ?? "unknown";
  let vramGB: number | null = null;
  let diskFreeGB = 0;
  const home = os.homedir();

  if (platform === "darwin") {
    const c = await capture(["sysctl", "-n", "machdep.cpu.brand_string"]);
    if (c.code === 0 && c.out) chip = c.out; // e.g. "Apple M5 Pro"
    diskFreeGB = parseMacDfGb((await capture(["df", "-g", home])).out);
    // Apple Silicon: the GPU shares unified memory, so ramGB is the real budget (vramGB stays null).
  } else if (platform === "linux") {
    if (Bun.which("nvidia-smi")) {
      const g = await capture(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
      vramGB = parseNvidiaSmiGb(g.out);
    }
    diskFreeGB = parseLinuxDfGb((await capture(["df", "-BG", "--output=avail", home])).out);
  }
  return { platform, arch, ramGB, cores, chip, vramGB, diskFreeGB };
}

// --- Hugging Face ------------------------------------------------------------------------------
// Confirm the repo hosts the exact GGUF before downloading (catches a stale catalog entry / typo).
async function hfFileExists(m: SetupModel): Promise<boolean | null> {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${m.hfRepo}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return r.status === 401 || r.status === 403 ? null : false; // gated => unknown, not absent
    const j = (await r.json()) as { siblings?: Array<{ rfilename: string }> };
    return (j.siblings ?? []).some((s) => s.rfilename === m.ggufFile);
  } catch {
    return null; // network hiccup: unknown, let the downloader be the source of truth
  }
}

async function download(m: SetupModel, dir: string, token: string | undefined): Promise<string> {
  const dest = `${dir}/${m.ggufFile}`;
  const existing = Bun.file(dest);
  // Treat as complete only when the file is close to the catalog's expected size. A smaller file is a
  // partial download; fall through so aria2c -c resumes it instead of wiring up a truncated GGUF.
  if ((await existing.exists()) && existing.size >= m.sizeGB * 1e9 * 0.95) {
    console.log(green(`  already downloaded: ${dest} (${(existing.size / 1e9).toFixed(1)} GB)`));
    return dest;
  }
  await mkdir(dir, { recursive: true });
  const url = hfResolveUrl(m);

  const tryAria2 = async (): Promise<boolean> => {
    if (!Bun.which("aria2c")) return false;
    console.log(dim(`  aria2c (16 connections, resumable) -> ${dest}`));
    const args = ["aria2c", "-c", "-x16", "-s16", "-k1M", "--file-allocation=none", "-d", dir, "-o", m.ggufFile];
    let confPath: string | undefined;
    if (token) {
      // Pass the auth header via a 0600 conf file, never on the argv -- otherwise the token is
      // visible to any local user through `ps`.
      confPath = `${dir}/.hf-auth-${process.pid}.conf`;
      await Bun.write(confPath, `header=Authorization: Bearer ${token}\n`);
      await chmod(confPath, 0o600);
      args.push(`--conf-path=${confPath}`);
    }
    args.push(url);
    try {
      return (await inherit(args)) === 0;
    } finally {
      if (confPath) await unlink(confPath).catch(() => {});
    }
  };

  const tryHf = async (): Promise<boolean> => {
    if (!Bun.which("hf")) return false;
    console.log(dim("  hf download (hf_transfer)"));
    const env: Record<string, string> = { HF_HUB_ENABLE_HF_TRANSFER: "1" };
    if (token) env.HF_TOKEN = token; // env, not argv -- not exposed via `ps`
    return (await inherit(["hf", "download", m.hfRepo, m.ggufFile, "--local-dir", dir], env)) === 0;
  };

  // With a token, prefer hf (passes it via env); without, prefer aria2c (fastest, no auth needed).
  for (const method of token ? [tryHf, tryAria2] : [tryAria2, tryHf]) {
    if (await method()) return dest;
  }
  throw new Error(
    "No downloader available or every method failed. Install aria2 (brew install aria2) or the HF CLI (pip install -U 'huggingface_hub[cli] hf_transfer').",
  );
}

// --- llama.cpp serving --------------------------------------------------------------------------
function llamaArgs(modelPath: string, port: number, id: string): string[] {
  // -ngl 99 offloads all layers to the GPU/Metal; --jinja uses the GGUF's own chat template;
  // -a <id> makes /v1/models report exactly this id so DEFAULT_MODEL matches.
  return ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-c", "32768", "-ngl", "99", "--jinja", "-a", id];
}

function launchAgentPlist(label: string, binPath: string, args: string[], home: string): string {
  // Escape XML metacharacters so a path/home/label containing & < > can't produce a malformed plist.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const argXml = [binPath, ...args].map((a) => `        <string>${esc(a)}</string>`).join("\n");
  const L = esc(label);
  const H = esc(home);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${L}</string>
    <key>ProgramArguments</key>
    <array>
${argXml}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key><string>${H}</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${H}/Library/Logs/${L}.out.log</string>
    <key>StandardErrorPath</key><string>${H}/Library/Logs/${L}.err.log</string>
</dict>
</plist>
`;
}

// --- .env upsert --------------------------------------------------------------------------------
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function upsertEnv(updates: Record<string, string>): Promise<string> {
  const cwd = process.cwd();
  const envPath = `${cwd}/.env`;
  let content = "";
  if (await Bun.file(envPath).exists()) content = await Bun.file(envPath).text();
  else if (await Bun.file(`${cwd}/.env.example`).exists()) content = await Bun.file(`${cwd}/.env.example`).text();
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${escapeRe(k)}=.*$`, "m");
    if (re.test(content)) content = content.replace(re, `${k}=${v}`);
    else content += `${content.endsWith("\n") ? "" : "\n"}${k}=${v}\n`;
  }
  await Bun.write(envPath, content);
  return envPath;
}

// --- endpoint checks ----------------------------------------------------------------------------
async function isPortFree(port: number): Promise<boolean> {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop();
    return true;
  } catch {
    return false;
  }
}
async function freePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) if (await isPortFree(p)) return p;
  throw new Error(`no free port in ${start}..${start + 49}; free one up (or stop a stale llama-server) and re-run.`);
}
async function waitHealthy(base: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(2000);
  }
  return false;
}
async function servesModel(base: string, id: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { data?: Array<{ id: string }> };
    return (j.data ?? []).some((m) => m.id === id);
  } catch {
    return false;
  }
}

// Stream one short turn and assert the first content delta is real text, not a leaked role marker
// (the MLX-template bug from the setup guide's Part C). llama.cpp should always pass this.
async function smokeTest(base: string, model: string): Promise<{ ok: boolean; reason?: string }> {
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "Reply with the word: pong" }] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  if (!res.ok || !res.body) return { ok: false, reason: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let first = "";
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break outer;
      try {
        const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        first += j.choices?.[0]?.delta?.content ?? "";
      } catch {
        // ignore keep-alive / non-JSON frames
      }
      if (first.trim().length >= 4) break outer;
    }
  }
  await reader.cancel().catch(() => {});
  if (!first.trim()) return { ok: false, reason: "empty reply" };
  if (isStrayRoleToken(first)) return { ok: false, reason: `stray role marker (${JSON.stringify(first.slice(0, 24))})` };
  return { ok: true };
}

// Detect an existing Jano router on the default port, and (Leo's stack) its models.json if present.
async function detectJano(janoUrl: string): Promise<{ present: boolean; modelsJson?: string }> {
  let present = false;
  try {
    const r = await fetch(`${janoUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    present = r.ok;
  } catch {
    present = false;
  }
  if (!present) return { present: false };
  const candidate = process.env.JANO_MODELS_JSON ?? `${os.homedir()}/steads/jano/models.json`;
  const modelsJson = (await Bun.file(candidate).exists()) ? candidate : undefined;
  return { present, modelsJson };
}

// --- main ---------------------------------------------------------------------------------------
function usage(): void {
  console.log(`${bold("a7t.chat setup")} -- one-command local install

  bun run setup                          interactive
  bun run setup --yes --model <id>       non-interactive (accept every default)
  bun run setup --dry-run                detect + recommend only (no downloads, no edits)
  bun run setup --help

  Models: ${SETUP_CATALOG.map((m) => m.id).join(", ")}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return usage();

  console.log(bold("\na7t.chat guided setup\n"));

  // 1. Detect hardware -------------------------------------------------------------------------
  step(1, "Detecting your machine");
  const hw = await detectHardware();
  const budget = budgetFor(hw);
  console.log(
    `  ${hw.chip}  ${dim("|")}  ${hw.ramGB} GB RAM  ${dim("|")}  ${hw.cores} cores  ${dim("|")}  ${
      hw.vramGB ? `${hw.vramGB} GB VRAM` : "unified memory"
    }  ${dim("|")}  ${hw.diskFreeGB} GB free`,
  );
  console.log(dim(`  model memory budget: ${budget} GB`));

  if (hw.platform !== "darwin") {
    console.log(
      yellow(
        `\n  Note: full support ships for macOS (Apple Silicon) first. On ${hw.platform} the wizard\n` +
          "  recommends + downloads a model and wires .env, but installs llama.cpp and the boot\n" +
          "  service manually (it prints the commands). Serving still works.",
      ),
    );
  }

  // 2. Recommend + pick ------------------------------------------------------------------------
  step(2, "Recommending a model that fits");
  const fits = recommend(hw);
  const forced = arg("model");
  let chosen: SetupModel | undefined;

  if (forced) {
    chosen = setupModelById(forced);
    if (!chosen) {
      console.error(red(`  unknown model "${forced}". Known: ${SETUP_CATALOG.map((m) => m.id).join(", ")}`));
      process.exit(1);
    }
  } else if (fits.length === 0) {
    console.log(
      yellow(
        `  No catalog model fits a ${budget} GB budget with ${hw.diskFreeGB} GB free disk.\n` +
          `  Re-run with --model <id> to force one, or free up memory/disk.`,
      ),
    );
    process.exit(1);
  } else {
    fits.forEach((m, i) => {
      const tag = i === 0 ? green("  (recommended)") : "";
      console.log(`  ${bold(String(i + 1))}. ${m.label}  ${dim(`${m.sizeGB} GB ${m.quant}, id: ${m.id}`)}${tag}`);
    });
    const pick = askStr("\n  Which model? (number or id)", "1");
    chosen =
      fits[Number.parseInt(pick, 10) - 1] ?? fits.find((m) => m.id === pick) ?? setupModelById(pick) ?? fits[0];
  }
  if (!chosen) {
    console.error(red("  no model selected."));
    process.exit(1);
  }
  console.log(`\n  Selected: ${bold(chosen.label)} ${dim(`(${chosen.sizeGB} GB, id ${chosen.id})`)}`);

  if (DRY) {
    console.log(dim("\n  --dry-run: stopping before any download or file change. Plan:"));
    console.log(
      `    download ${chosen.ggufFile} from ${chosen.hfRepo}\n` +
        `    serve with llama.cpp, set DEFAULT_MODEL=${chosen.id}, verify a clean turn.`,
    );
    return;
  }

  // 3. Download from Hugging Face --------------------------------------------------------------
  step(3, "Downloading the model");
  const exists = await hfFileExists(chosen);
  if (exists === false) {
    console.log(yellow(`  ${chosen.ggufFile} was not found in ${chosen.hfRepo} on Hugging Face.`));
    if (!ask("  Continue anyway?", false)) process.exit(1);
  }
  let token = process.env.HF_TOKEN;
  if (!token && !YES && ask("  Is this a gated/private repo needing a Hugging Face token?", false)) {
    console.log(dim("  Tip: set HF_TOKEN in your environment to avoid typing it (it is visible as you type)."));
    token = askStr("  Paste your HF token", "") || undefined;
  }
  const modelsDir = `${os.homedir()}/models`;
  const modelPath = await download(chosen, modelsDir, token);

  // 4. Ensure llama.cpp (install on macOS if possible; never a hard stop so the manual path works)
  step(4, "Serving with llama.cpp");
  let haveServer = Bun.which("llama-server") != null;
  if (!haveServer && hw.platform === "darwin" && Bun.which("brew") && ask("  Install llama.cpp via Homebrew?", true)) {
    await inherit(["brew", "install", "llama.cpp"]);
    haveServer = Bun.which("llama-server") != null;
  }
  if (!haveServer) {
    console.log(
      yellow(
        "  llama-server is not installed. Install llama.cpp (macOS: brew install llama.cpp; Linux: a\n" +
          "  prebuilt release from github.com/ggml-org/llama.cpp), then run the serve command printed below.",
      ),
    );
  }

  const port = await freePort(8091);
  const serverUrl = `http://127.0.0.1:${port}`;
  const args = llamaArgs(modelPath, port, chosen.id);
  const binPath = Bun.which("llama-server") ?? "llama-server";
  const serveCmd = [binPath, ...args].join(" ");

  // 5. Wire .env -- ALWAYS, before the start-mode branch, so the manual / Linux path is left ready.
  step(5, "Wiring .env");
  const jano = await detectJano(process.env.JANO_URL ?? "http://127.0.0.1:8082");
  let janoUrl = serverUrl;
  if (jano.present && ask("  A router already answers on :8082. Route a7t.chat through it instead of llama-server?", true)) {
    janoUrl = process.env.JANO_URL ?? "http://127.0.0.1:8082";
    if (jano.modelsJson && ask(`  Register ${chosen.id} in ${jano.modelsJson} and restart Jano?`, true)) {
      await registerWithJano(jano.modelsJson, chosen, serverUrl);
    } else {
      console.log(dim(`  Point your router at ${serverUrl} and expose it as "${chosen.id}", then continue.`));
    }
  }
  const updates: Record<string, string> = { JANO_URL: janoUrl, DEFAULT_MODEL: chosen.id };
  const adminLogin = askStr("  Owner email for first-run local admin (DEV_ADMIN_LOGIN, blank to skip)", process.env.DEV_ADMIN_LOGIN ?? "");
  if (adminLogin) updates.DEV_ADMIN_LOGIN = adminLogin;
  const envPath = await upsertEnv(updates);
  console.log(green(`  wrote ${envPath}: JANO_URL=${janoUrl}, DEFAULT_MODEL=${chosen.id}`));

  // 6. Start the model: boot service / foreground / manual (never forced) ----------------------
  step(6, "Starting the model");
  const mode =
    haveServer && hw.platform === "darwin"
      ? askStr("  Start mode: (f)oreground for this session, (s)ervice on boot, (m)anual command?", "f")
      : "m";
  let started = false;
  if (mode.startsWith("s") && hw.platform === "darwin") {
    const label = "com.a7t.llama-server";
    const plist = `${os.homedir()}/Library/LaunchAgents/${label}.plist`;
    await Bun.write(plist, launchAgentPlist(label, binPath, args, os.homedir()));
    const uid = process.getuid?.() ?? 501;
    await capture(["launchctl", "bootout", `gui/${uid}/${label}`]); // clear any prior instance (ignore errors)
    await inherit(["launchctl", "bootstrap", `gui/${uid}`, plist]);
    console.log(green(`  boot service installed: ${label} (survives reboots).`));
    started = true;
  } else if (mode.startsWith("f") && hw.platform === "darwin") {
    const logDir = `${os.homedir()}/Library/Logs`;
    await mkdir(logDir, { recursive: true });
    const log = Bun.file(`${logDir}/a7t-llama-server.log`);
    const proc = Bun.spawn([binPath, ...args], { stdio: ["ignore", log, log] });
    proc.unref();
    console.log(green(`  llama-server started (PID ${proc.pid}). Logs: ${logDir}/a7t-llama-server.log`));
    console.log(dim(`  It runs until you reboot or: kill ${proc.pid}. Re-run and pick (s) for a boot service.`));
    started = true;
  } else {
    console.log("  Start the model yourself (your .env already points at it):");
    console.log(bold(`    ${serveCmd}`));
  }

  // 7. Verify -- only when we actually started the server (manual mode has nothing up yet) ------
  if (started) {
    step(7, "Verifying");
    process.stdout.write(dim("  waiting for the server to come up ..."));
    const healthy = await waitHealthy(janoUrl);
    console.log(healthy ? green(" up") : red(" timed out"));
    if (healthy) {
      if (!(await servesModel(janoUrl, chosen.id))) {
        console.log(yellow(`  ${janoUrl}/v1/models does not list "${chosen.id}" yet. If you used a router, register it there.`));
      }
      const smoke = await smokeTest(janoUrl, chosen.id);
      console.log(
        smoke.ok
          ? green("  streaming smoke test: clean (no stray role token)")
          : red(`  streaming smoke test failed: ${smoke.reason}`),
      );
    } else {
      console.log(yellow(`  ${janoUrl}/health never returned 200. Check the server logs; the app still runs once it is up.`));
    }
  }

  // 8. Next steps ------------------------------------------------------------------------------
  step(8, "Done");
  console.log(`  Start a7t.chat:  ${bold("bun run db:migrate && (cd web && bun run build) && bun run start")}`);
  console.log(`  Then open:       ${bold("http://127.0.0.1:8787")}`);
}

async function registerWithJano(modelsJson: string, m: SetupModel, url: string): Promise<void> {
  const backup = `${modelsJson}.bak`;
  const raw = await Bun.file(modelsJson).text();
  await Bun.write(backup, raw);
  const parsed = JSON.parse(raw) as { models?: Array<{ name: string; label?: string; url: string; aliases?: string[] }> };
  const models = parsed.models ?? [];
  if (!models.some((x) => x.name === m.id)) {
    models.push({ name: m.id, label: m.label, url, aliases: [`${m.hfRepo}`] });
  }
  await Bun.write(modelsJson, `${JSON.stringify({ ...parsed, models }, null, 2)}\n`);
  console.log(green(`  registered ${m.id} in ${modelsJson} (backup: ${backup})`));
  const uid = process.getuid?.() ?? 501;
  await capture(["launchctl", "kickstart", "-k", `gui/${uid}/com.jano.jano`]);
  console.log(dim("  restarted Jano (it reads models.json at startup)."));
}

main().catch((e: unknown) => {
  console.error(red(`\nsetup failed: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
