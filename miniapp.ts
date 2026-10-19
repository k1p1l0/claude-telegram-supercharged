/**
 * Telegram Mini App: a live board of the Claude Code sessions on this machine.
 *
 * server.ts calls startMiniApp() in the instance that owns the bot. The HTTP
 * server binds to 127.0.0.1 only; put it behind HTTPS (Tailscale Serve or
 * Funnel, Cloudflare Tunnel) and set TELEGRAM_MINIAPP_URL to that address.
 * With TELEGRAM_MINIAPP_URL=auto the bot runs a Cloudflare quick tunnel itself.
 * With TELEGRAM_MINIAPP_PEERS the board can also show other machines that run this plugin.
 * Every API call must carry Telegram initData signed for this bot by a user on
 * the allowlist, so the public URL shows nothing to anyone else.
 * With TELEGRAM_WEBHOOK=on the same server also takes Telegram's updates at
 * POST /telegram/webhook (server.ts checks the secret token).
 * With TELEGRAM_MINIAPP_TOWN_FEED the page also gets a Town view (GET /api/town, see parseTownFeed).
 * Users that server.ts lets control sessions can also read a session's messages,
 * send it a message, start background tasks, stop them and signal terminal
 * sessions (POST /api/control). TELEGRAM_MINIAPP_CONTROL=off turns that off.
 *
 * Data comes from `claude agents --json` (live sessions, busy or idle) and the
 * transcripts in ~/.claude/projects (tokens, model, tool calls, subagents).
 * Transcripts can be hundreds of MB, so a worker thread reads them in chunks,
 * keeps byte offsets, and only polls while someone has the app open.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";

// ── Shared types (the page in miniapp/index.html renders these) ───────

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ToolRef = { name: string; target: string; t: number };
/** One line of a turn's timeline: a short reply text, or a tool call when `tool` is set. */
type Step = { t: number; text: string; tool?: string };

/** The latest turn of a session: the prompt that started it and what Claude did since. */
interface TurnView {
  prompt: string;
  /** The last text Claude wrote in this turn, clipped. */
  text: string;
  startedAt: number;
  /** The time of the last assistant record of the turn. */
  endedAt: number;
  /** Read, Grep, Glob, WebSearch, WebFetch and other calls that only look. */
  searches: number;
  /** All other tool calls. */
  tools: number;
  steps: Step[];
}

interface AgentView {
  id: string;
  type: string;
  description: string;
  status: "running" | "done";
  model: string | null;
  tokens: Usage;
  toolCalls: number;
  currentTool: ToolRef | null;
  lastTool: ToolRef | null;
  startedAt: number;
  lastActivity: number;
}

interface SessionView {
  id: string;
  name: string;
  project: string;
  cwd: string;
  kind: string;
  /**
   * waiting: Claude Code waits for the user (a permission prompt or a dialog), see waitingFor.
   * stopped: a background session without a process, listed by `claude agents --all`.
   */
  status: "busy" | "waiting" | "idle" | "stopped";
  /** What a waiting session waits for, as `claude agents --json` reports it ("input needed", "dialog open"). */
  waitingFor: string | null;
  startedAt: number;
  model: string | null;
  contextTokens: number;
  contextWindow: number;
  tokens: Usage;
  toolCalls: number;
  currentTool: ToolRef | null;
  lastTool: ToolRef | null;
  lastActivity: number;
  agents: AgentView[];
  agentsTotal: number;
  turn: TurnView | null;
  /** Controls that apply to this session (peek send stop logs rm interrupt terminate bot-new). */
  actions: string[];
}

interface Activity {
  t: number;
  sessionId: string;
  session: string;
  agent: string | null;
  tool: string;
  target: string;
}

interface Snapshot {
  now: number;
  host: string;
  ready: boolean;
  totals: {
    sessions: number;
    busy: number;
    waiting: number;
    agentsRunning: number;
    agents24h: number;
    toolCalls24h: number;
    tokens24h: Usage;
  };
  hourly: Array<Usage & { t: number; tools: number }>;
  sessions: SessionView[];
  activity: Activity[];
  /** Folders a new background task can start in, most recently used first. */
  projects: Array<{ cwd: string; name: string }>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// This process and its parents: `bun run`, the Claude Code session that runs the plugin (the daemon),
// its wrapper and the supervisor. The board never signals these, and shows the session as the bot's own.
let ancestors: Set<number> | null = null;
function ancestorPids(): Set<number> {
  if (ancestors) return ancestors;
  const pids = new Set([process.pid]);
  let pid = process.ppid;
  for (let i = 0; i < 16 && pid > 1 && !pids.has(pid); i++) {
    pids.add(pid);
    try {
      pid = Number(
        Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
          .stdout.toString()
          .trim(),
      );
    } catch {
      break;
    }
  }
  ancestors = pids;
  return pids;
}

function projectsRoot(): string {
  const home = userInfo().homedir || homedir();
  return join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

// ── Main thread: HTTP server, auth, /agents button ────────────────────

// TELEGRAM_MINIAPP_URL=auto: the address of the quick tunnel that startQuickTunnel() keeps running.
const tunnel: { url: string; state: "off" | "starting" | "up" | "missing" } = { url: "", state: "off" };

const isAuto = () => (process.env.TELEGRAM_MINIAPP_URL ?? "").trim() === "auto";

const urlListeners: Array<(url: string) => void> = [];

/** Calls fn with the new public address each time the quick tunnel gets one (webhook mode sets it again). */
export function onMiniAppUrlChange(fn: (url: string) => void): void {
  urlListeners.push(fn);
}

/** The public HTTPS address of the Mini App, or "" when it is not set up. */
export function miniAppUrl(): string {
  // Keep a trailing slash: the page loads the relative `api/state`, which must stay under any path prefix.
  const url = isAuto() ? tunnel.url : (process.env.TELEGRAM_MINIAPP_URL ?? "").trim();
  return url && !url.endsWith("/") ? `${url}/` : url;
}

/** The /agents reply when there is no HTTPS address yet. */
export function miniAppSetupHint(): string {
  const port = Number(process.env.TELEGRAM_MINIAPP_PORT) || 8790;
  if (process.env.TELEGRAM_MINIAPP === "off") return "The agents board is turned off (TELEGRAM_MINIAPP=off).";
  if (isAuto()) {
    return tunnel.state === "missing"
      ? "TELEGRAM_MINIAPP_URL=auto needs cloudflared. Install it (brew install cloudflared) and restart the bot."
      : "The tunnel for the agents board is starting. Send /agents again in a few seconds.";
  }
  return `The agents board needs an HTTPS address. The easiest way: install cloudflared and set TELEGRAM_MINIAPP_URL=auto in ~/.claude/channels/telegram/.env. Or expose 127.0.0.1:${port} yourself, for example with tailscale serve --bg ${port}, and set TELEGRAM_MINIAPP_URL=https://… there. Then restart.`;
}

// A process killed with SIGKILL cannot stop its tunnel. Stop the one it left behind.
function stopStaleTunnel(pidFile: string, port: number): void {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!pid) return;
    const cmd = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]).stdout.toString();
    if (cmd.includes("cloudflared") && cmd.includes(`127.0.0.1:${port}`)) process.kill(pid, "SIGTERM");
  } catch {}
}

// Runs `cloudflared tunnel --url` and restarts it when it exits. The address is random and changes
// on every start, so /agents reads the current one.
function startQuickTunnel(port: number, log: (msg: string) => void): void {
  const pidFile = join(tmpdir(), `claude-telegram-miniapp-tunnel-${port}.pid`);
  stopStaleTunnel(pidFile, port);
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let delay = 5_000;
  process.on("exit", () => proc?.kill());

  // The launchd PATH of the daemon often lacks the Homebrew folders.
  const bin =
    Bun.which("cloudflared") ??
    ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((p) => existsSync(p)) ??
    "cloudflared";

  const run = () => {
    try {
      proc = Bun.spawn([bin, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
        stdout: "ignore",
        stderr: "pipe",
      });
    } catch {
      tunnel.state = "missing";
      log("mini app: TELEGRAM_MINIAPP_URL=auto needs cloudflared on PATH (brew install cloudflared)");
      return;
    }
    const current = proc;
    tunnel.state = "starting";
    try {
      writeFileSync(pidFile, String(current.pid));
    } catch {}
    void (async () => {
      // cloudflared prints the address to stderr, then a line for each connection to the edge.
      // Use the address after the first connection. Keep reading after that, so the pipe never fills.
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of current.stderr as ReadableStream<Uint8Array>) {
        if (tunnel.state === "up") continue;
        text += decoder.decode(chunk, { stream: true });
        const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(text);
        if (m && text.includes("Registered tunnel connection")) {
          tunnel.url = m[0];
          tunnel.state = "up";
          delay = 5_000;
          log(`mini app: quick tunnel ${m[0]}`);
          // A listener that throws must not stop this loop: the pipe would fill and block cloudflared.
          for (const fn of urlListeners) {
            try {
              fn(miniAppUrl());
            } catch {}
          }
        } else if (text.length > 64_000) text = `${m ? m[0] : ""}\n${text.slice(-4_000)}`;
      }
    })();
    void current.exited.then((code) => {
      tunnel.url = "";
      tunnel.state = "starting";
      log(`mini app: quick tunnel exited (code ${code}), restarting in ${delay / 1000} s`);
      setTimeout(run, delay);
      delay = Math.min(delay * 2, 300_000);
    });
  };
  run();
}

/**
 * Check Telegram WebApp initData (https://core.telegram.org/bots/webapps).
 * Returns the Telegram user id when the HMAC matches this bot and the data is
 * younger than maxAgeSec, otherwise null.
 */
export function verifyInitData(raw: string, token: string, maxAgeSec = DAY / 1000): string | null {
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = Buffer.from(hash, "hex");
  // Clients since Bot API 8.0 also send `signature`; accept the check string with or without it.
  const valid = [["hash"], ["hash", "signature"]].some((skip) => {
    const check = [...params.entries()]
      .filter(([k]) => !skip.includes(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    return timingSafeEqual(createHmac("sha256", secret).update(check).digest(), expected);
  });
  if (!valid) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const id = JSON.parse(params.get("user") ?? "{}").id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

/** The request's Telegram user id when its `Authorization: tma <initData>` is valid, fresh and allowlisted. */
export function telegramUserOf(token: string, isAllowed: (userId: string) => boolean) {
  return (req: Request): string | null => {
    const m = /^tma (.+)$/.exec(req.headers.get("authorization") ?? "");
    const userId = m ? verifyInitData(m[1], token) : null;
    return userId && isAllowed(userId) ? userId : null;
  };
}

type NeedsApi = {
  list: () => Promise<unknown>;
  answer: (userId: string, body: Record<string, unknown>) => Promise<[number, Record<string, unknown>]>;
};

/**
 * GET /api/needs and POST /api/needs/answer. Null when the path is not one of them. Both need valid initData
 * of an allowlisted user. The log line carries the code and the result, never initData or a token.
 */
export async function needsRoute(
  req: Request,
  pathname: string,
  userOf: (req: Request) => string | null,
  needs: NeedsApi | undefined,
  log: (msg: string) => void,
): Promise<Response | null> {
  if (pathname !== "/api/needs" && pathname !== "/api/needs/answer") return null;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  const answer = pathname === "/api/needs/answer";
  if (req.method !== (answer ? "POST" : "GET")) return new Response("Method not allowed", { status: 405 });
  const userId = userOf(req);
  if (!userId) return json({ error: "unauthorized" }, 401);
  if (!needs) return json({ error: "needs list is not installed" }, 404);
  if (!answer) {
    try {
      return json(await needs.list());
    } catch (err) {
      log(`mini app: needs list failed: ${err}`);
      return json({ error: "could not build the list" }, 500);
    }
  }
  const body = await readJsonBody(req);
  if (typeof body === "string") return json({ error: body }, 400);
  const [status, reply] = await needs.answer(userId, body);
  log(
    `mini app: needs answer ${str(body.code).slice(0, 64)} -> ${status}${reply.reason ? ` ${str(reply.reason)}` : ""}`,
  );
  return json(reply, status);
}

// Other machines the board can switch to: TELEGRAM_MINIAPP_PEERS="name=url,name2=url2". Each one runs
// this plugin too and shares TELEGRAM_MINIAPP_PEER_TOKEN, which guards its /api/peer/state.
function peerList(): Map<string, string> {
  const peers = new Map<string, string>();
  for (const part of (process.env.TELEGRAM_MINIAPP_PEERS ?? "").split(",")) {
    const eq = part.indexOf("=");
    const name = part.slice(0, eq).trim();
    const url = part
      .slice(eq + 1)
      .trim()
      .replace(/\/+$/, "");
    if (eq > 0 && name !== "local" && /^https?:\/\/\S+$/.test(url)) peers.set(name, url);
  }
  return peers;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

// ── Main thread: session controls ─────────────────────────────────────

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODES = new Set(["plan", "acceptEdits", "default"]);
const MAX_BODY = 16 * 1024;
const MAX_TEXT = 8000;
const CONTROLS_PER_MINUTE = 10;

interface AgentEntry {
  sessionId: string;
  /** Background sessions: the short id that stop, logs and rm take. */
  id?: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  status?: string;
  state?: string;
  name?: string;
}

interface Task {
  id: string;
  userId: string;
  project: string;
  prompt: string;
  startedAt: number;
}

type Reply = [status: number, body: Record<string, unknown>];

// A child with these would take itself for the daemon session or reach the bot.
const CHILD_ENV_DROP =
  /^(TELEGRAM_|CLAUDE_PLUGIN_|CLAUDE_CODE_MESSAGING_)|^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ID|CLAUDE_SESSION_ID|CLAUDE_PROJECT_DIR|CLAUDE_PID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_BRIDGE_SESSION_ID|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_ENV_FILE|AI_AGENT)$/;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CHILD_ENV_DROP.test(k)) env[k] = v;
  return env;
}

/** Runs the claude CLI with an args array, never through a shell. SIGKILL after 20 s. */
async function runClaude(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; out: string }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["claude", ...args], { cwd, env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return { code: null, stdout: "", out: `cannot run claude: ${err}` };
  }
  const text = ["", ""];
  const readers = [proc.stdout, proc.stderr].map((s) => (s as ReadableStream<Uint8Array>).getReader());
  const reading = Promise.all(
    readers.map(async (r, i) => {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        text[i] += decoder.decode(value, { stream: true });
      }
    }),
  ).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 20_000);
  });
  const code = await Promise.race([proc.exited, timeout]).finally(() => clearTimeout(timer));
  // `claude --bg` can start a background service that inherits the pipes. Do not wait for it to close them.
  await Promise.race([reading, Bun.sleep(300)]);
  for (const r of readers) r.cancel().catch(() => {});
  return { code, stdout: text[0], out: `${text[0]}\n${text[1]}`.trim() };
}

async function agentsList(): Promise<AgentEntry[] | null> {
  const { code, stdout } = await runClaude(["agents", "--json", "--all"]);
  if (code !== 0) return null;
  try {
    const list = JSON.parse(stdout);
    return Array.isArray(list) ? list.filter((s) => typeof s?.sessionId === "string") : null;
  } catch {
    return null;
  }
}

const ESC = String.fromCharCode(27);
const ANSI_MOVE_LINE = new RegExp(`${ESC}\\[\\d*(?:;\\d*)?[BEFHf]`, "g");
const ANSI_MOVE_RIGHT = new RegExp(`${ESC}\\[\\d*[CG]`, "g");
const ANSI_REST = new RegExp(
  `${ESC}\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)|${ESC}\\[[0-9;?<>=]*[A-Za-z~]|${ESC}[()][A-Z0-9]|${ESC}.`,
  "g",
);

// `claude logs` replays the terminal screen. Turn cursor moves into line breaks and spaces, drop the
// other escape codes, rules and repeated lines, so the text reads top to bottom.
function plainLogs(raw: string): string {
  const lines = raw
    .replace(ANSI_MOVE_LINE, "\n")
    .replace(ANSI_MOVE_RIGHT, " ")
    .replace(ANSI_REST, "")
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    // Rules, and spinner frames: lines with fewer than two letters or digits.
    .filter((l) => l.replace(/[^\p{L}\p{N}]/gu, "").length > 1);
  return lines.filter((l, i) => l !== lines[i - 1]).join("\n");
}

const firstLine = (s: string) => clip(s.split("\n").find((l) => l.trim()) ?? "", 300);

function transcriptPath(sessionId: string): string | null {
  const root = projectsRoot();
  try {
    for (const p of readdirSync(root)) {
      const path = join(root, p, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  } catch {}
  return null;
}

type ChatMessage = { role: "user" | "assistant"; text: string; ts: number };

// Text blocks of one transcript line. A tool call becomes one short line, like [Bash] git status.
function lineMessages(e: any): ChatMessage[] {
  if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || e.isSidechain) return [];
  const role = e.type as ChatMessage["role"];
  const ts = Date.parse(e.timestamp) || 0;
  const cut = (t: string) => (t.length > 4000 ? `${t.slice(0, 3999)}…` : t);
  const content = e.message?.content;
  if (typeof content === "string") return content.trim() ? [{ role, text: cut(content.trim()), ts }] : [];
  const out: ChatMessage[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === "text" && typeof c.text === "string" && c.text.trim())
      out.push({ role, text: cut(c.text.trim()), ts });
    else if (role === "assistant" && c?.type === "tool_use" && !HIDDEN_TOOLS.has(c.name)) {
      const target = describe(String(c.name), c.input ?? {});
      out.push({ role, text: `[${c.name}]${target ? ` ${target}` : ""}`, ts });
    }
  }
  return out;
}

// The last messages of a transcript. Reads from the end and widens the window until enough are found.
async function readMessages(path: string, limit: number): Promise<ChatMessage[]> {
  const size = statSync(path).size;
  for (let window = 1 << 20; ; window *= 4) {
    const start = Math.max(0, size - window);
    const lines = (await Bun.file(path).slice(start, size).text()).split("\n");
    if (start > 0) lines.shift();
    const messages: ChatMessage[] = [];
    for (const line of lines) {
      if (!line.startsWith("{") || !/"type":"(?:user|assistant)"/.test(line)) continue;
      try {
        messages.push(...lineMessages(JSON.parse(line)));
      } catch {}
    }
    if (messages.length >= limit || start === 0 || window >= 32 << 20) return messages.slice(-limit);
  }
}

// Reads a JSON object body of at most 16 KB. A string is the error to return.
async function readJsonBody(req: Request): Promise<Record<string, unknown> | string> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? ""))
    return "Content-Type must be application/json";
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return "body too large";
  const reader = req.body?.getReader();
  if (!reader) return "empty body";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      reader.cancel().catch(() => {});
      return "body too large";
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : "body must be a JSON object";
  } catch {
    return "invalid JSON";
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// ── Town view: an optional feed of agents, rooms, messages and tasks ──
//
// TELEGRAM_MINIAPP_TOWN_FEED points at a JSON feed (schema version 1) that something else produces.
// The server fetches it with TELEGRAM_MINIAPP_TOWN_TOKEN, so the token never reaches the browser,
// and passes on only the known fields, clipped. The page shows each room as a card with its agents as rows,
// and the Claude accounts' usage limits when the feed has a usage block.

type TownState = "busy" | "waiting" | "idle" | "offline";
type TownKind = "claude-daemon" | "pi" | "claude-session" | "other";
/** A time as epoch ms. A value that is not a time stays as short text. */
type TownStamp = number | string | null;

interface TownRoom {
  id: string;
  title: string;
  kind: "hub" | "project";
}
interface TownAgent {
  name: string;
  /** The name Kyrylo knows the agent by (Veyra, Soren); "" when the feed has none. */
  display_name: string;
  room: string;
  department: string;
  role: string;
  kind: TownKind;
  listening: boolean;
  state: TownState;
  waiting_for: string | null;
  activity: string;
  last_in: TownStamp;
  last_out: TownStamp;
}
interface TownMessage {
  id: string;
  from: string;
  to: string;
  ts: number | null;
  task_id: string | null;
  preview: string;
}
interface TownTask {
  id: string;
  project: string;
  title: string;
  state: string;
  owner: string;
  updated_at: number | null;
}
/** One usage window of a Claude account: 5 h, 7 d, or a scoped one such as Fable. */
interface UsageWindow {
  name: string;
  /** Share used, 0 to 100; null when the feed sent no number. */
  pct: number | null;
  countdown: string | null;
  reset_at: string | null;
}
interface UsageAccount {
  number: number | null;
  label: string;
  plan: string;
  active: boolean;
  usage_status: string;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  scoped: UsageWindow[];
}
export interface TownUsage {
  state: "ok" | "stale" | "unavailable";
  read_at: string | null;
  detail: string | null;
  no_room: boolean;
  accounts: UsageAccount[];
}
export interface TownFeed {
  version: 1;
  generated_at: number | null;
  machine: string;
  rooms: TownRoom[];
  agents: TownAgent[];
  messages: TownMessage[];
  tasks: TownTask[];
  usage: TownUsage | null;
}

const TOWN_TIMEOUT_MS = 3000;
const TOWN_MAX_BYTES = 1 << 20;
const TOWN_CACHE_MS = 1500;
const TOWN_STATES = new Set(["busy", "waiting", "idle", "offline"]);
const TOWN_KINDS = new Set(["claude-daemon", "pi", "claude-session", "other"]);

/** The feed address from TELEGRAM_MINIAPP_TOWN_FEED, or "" when it is unset or not an http(s) URL. */
export function townFeedUrl(): string {
  const url = (process.env.TELEGRAM_MINIAPP_TOWN_FEED ?? "").trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : "";
}

/** Epoch ms from a number (seconds or ms) or a date string, else null. */
function townTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function townStamp(v: unknown): TownStamp {
  const t = townTime(v);
  if (t !== null) return t;
  return typeof v === "string" && v.trim() ? clip(v, 120) : null;
}

// Strings and numbers become clipped text; anything else becomes "".
const townText = (v: unknown, n: number) => (typeof v === "string" || typeof v === "number" ? clip(v, n) : "");
const townList = (v: unknown, max: number): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && !Array.isArray(x)).slice(0, max);

/** Checks a version 1 feed and keeps only the known fields. Returns null when the shape is wrong. */
export function parseTownFeed(raw: unknown): TownFeed | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (f.version !== 1 || !Array.isArray(f.rooms) || !Array.isArray(f.agents)) return null;

  const rooms: TownRoom[] = [];
  const roomIds = new Set<string>();
  for (const r of townList(f.rooms, 60)) {
    const id = townText(r.id, 64);
    if (!id || roomIds.has(id)) continue;
    roomIds.add(id);
    rooms.push({ id, title: townText(r.title, 80) || id, kind: r.kind === "hub" ? "hub" : "project" });
  }

  const agents: TownAgent[] = [];
  const names = new Set<string>();
  for (const a of townList(f.agents, 300)) {
    const name = townText(a.name, 64);
    if (!name || names.has(name)) continue;
    names.add(name);
    agents.push({
      name,
      display_name: townText(a.display_name, 40),
      room: townText(a.room, 64),
      department: townText(a.department, 64),
      role: townText(a.role, 80),
      kind: TOWN_KINDS.has(a.kind as string) ? (a.kind as TownKind) : "other",
      listening: a.listening === true,
      state: TOWN_STATES.has(a.state as string) ? (a.state as TownState) : "idle",
      waiting_for: townText(a.waiting_for, 200) || null,
      activity: townText(a.activity, 200),
      last_in: townStamp(a.last_in),
      last_out: townStamp(a.last_out),
    });
  }

  const messages: TownMessage[] = [];
  const msgIds = new Set<string>();
  for (const m of townList(f.messages, 50)) {
    const from = townText(m.from, 64);
    const to = townText(m.to, 64);
    const ts = townTime(m.ts);
    // A message without an id still needs a stable key, so the page can tell new ones from old ones.
    const id = townText(m.id, 80) || `${from}>${to}@${ts ?? ""}`;
    if (msgIds.has(id)) continue;
    msgIds.add(id);
    messages.push({ id, from, to, ts, task_id: townText(m.task_id, 80) || null, preview: townText(m.preview, 300) });
  }

  const tasks: TownTask[] = [];
  for (const t of townList(f.tasks, 300)) {
    const title = townText(t.title, 160);
    if (!title) continue;
    tasks.push({
      id: townText(t.id, 80),
      project: townText(t.project, 64),
      title,
      state: townText(t.state, 32),
      owner: townText(t.owner, 64),
      updated_at: townTime(t.updated_at),
    });
  }

  return {
    version: 1,
    generated_at: townTime(f.generated_at),
    machine: townText(f.machine, 64),
    rooms,
    agents,
    messages,
    tasks,
    usage: parseTownUsage(f.usage),
  };
}

const USAGE_STATES = new Set(["ok", "stale", "unavailable"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// A date string that parses, clipped; anything else is null. The page formats it.
const usageIso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? clip(v, 40) : null);

function usageWindow(v: unknown): UsageWindow | null {
  if (!isObj(v)) return null;
  const name = townText(v.name, 40);
  if (!name) return null;
  const pct = typeof v.pct === "number" && Number.isFinite(v.pct) ? Math.min(100, Math.max(0, v.pct)) : null;
  return { name, pct, countdown: townText(v.countdown, 40) || null, reset_at: usageIso(v.reset_at) };
}

/** Checks the feed's optional usage block (Claude account limits). Returns null when it is missing or the wrong shape. */
export function parseTownUsage(raw: unknown): TownUsage | null {
  if (!isObj(raw) || !USAGE_STATES.has(raw.state as string)) return null;
  const accounts: UsageAccount[] = [];
  for (const a of townList(raw.accounts, 12)) {
    const n = typeof a.number === "string" && a.number.trim() ? Number(a.number) : a.number;
    accounts.push({
      number: typeof n === "number" && Number.isFinite(n) ? n : null,
      label: townText(a.label, 64),
      plan: townText(a.plan, 32),
      active: a.active === true,
      usage_status: townText(a.usage_status, 32),
      five_hour: usageWindow(a.five_hour),
      seven_day: usageWindow(a.seven_day),
      scoped: townList(a.scoped, 8)
        .map(usageWindow)
        .filter((w): w is UsageWindow => w !== null),
    });
  }
  return {
    state: raw.state as TownUsage["state"],
    read_at: usageIso(raw.read_at),
    detail: townText(raw.detail, 300) || null,
    no_room: raw.no_room === true,
    accounts,
  };
}

// Reads a response body of at most `max` bytes. Returns null when it is larger.
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Fetches and checks the town feed. Never throws: a failure is [502, { error }]. */
export async function fetchTownFeed(url: string, token: string): Promise<Reply> {
  try {
    const res = await globalThis.fetch(url, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // A redirect could carry the token to another host.
      redirect: "error",
      signal: AbortSignal.timeout(TOWN_TIMEOUT_MS),
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return [502, { error: "feed failed", detail: `HTTP ${res.status}` }];
    }
    const text = await readCapped(res, TOWN_MAX_BYTES);
    if (text === null) return [502, { error: "feed too large" }];
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return [502, { error: "feed is not JSON" }];
    }
    const feed = parseTownFeed(raw);
    if (!feed) return [502, { error: "feed does not match schema version 1" }];
    return [200, { ...feed, fetched_at: Date.now() }];
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return [502, { error: timeout ? "feed timed out" : "feed unreachable" }];
  }
}

export function startMiniApp(opts: {
  token: string;
  isAllowed: (userId: string) => boolean;
  /** May this user read messages and control sessions? Without it, the board is read-only. */
  canControl?: (userId: string) => boolean;
  /** The "New session" button: the same as the /new command. */
  newSession?: () => void;
  /** Sends a Telegram message to a user: the notice when a task from the board finishes. */
  notify?: (userId: string, text: string) => unknown;
  /** The "Needs you" list: GET /api/needs and POST /api/needs/answer. Without it both routes answer 404. */
  needs?: NeedsApi;
  /** Where the board keeps the tasks it watches, so a restart does not lose them. */
  dataDir?: string;
  log: (msg: string) => void;
  /** TELEGRAM_WEBHOOK=on: handles POST /telegram/webhook. With TELEGRAM_MINIAPP=off the server runs for this route only. */
  webhook?: (req: Request) => Response | Promise<Response>;
}): void {
  const board = process.env.TELEGRAM_MINIAPP !== "off";
  if (!board && !opts.webhook) return;
  const port = Number(process.env.TELEGRAM_MINIAPP_PORT) || 8790;
  // 127.0.0.1 by default. A machine that other boards read from binds its tailnet address or "::".
  const host = process.env.TELEGRAM_MINIAPP_HOST || "127.0.0.1";
  const htmlPath = join(import.meta.dir, "miniapp", "index.html");
  let worker: Worker | null = null;
  let snapshot: Snapshot | null = null;

  const peerToken = (process.env.TELEGRAM_MINIAPP_PEER_TOKEN ?? "").trim();
  const peerSecret = peerToken.length >= 16 ? peerToken : "";
  if (peerToken && !peerSecret) opts.log("mini app: TELEGRAM_MINIAPP_PEER_TOKEN needs at least 16 characters");
  if (process.env.TELEGRAM_MINIAPP_PEERS && !peerSecret)
    opts.log("mini app: TELEGRAM_MINIAPP_PEERS is ignored without TELEGRAM_MINIAPP_PEER_TOKEN");
  const peers = peerSecret ? peerList() : new Map<string, string>();
  const machines = [{ id: "local", name: machineName() }, ...[...peers.keys()].map((name) => ({ id: name, name }))];

  // Town view: on only with a feed address. Every board polls it every 3 s, so readers share one fetch.
  const townUrl = townFeedUrl();
  const townToken = (process.env.TELEGRAM_MINIAPP_TOWN_TOKEN ?? "").trim();
  if (process.env.TELEGRAM_MINIAPP_TOWN_FEED?.trim() && !townUrl)
    opts.log("mini app: TELEGRAM_MINIAPP_TOWN_FEED must be an http(s) URL; the Town view stays off");
  let townCache: { at: number; reply: Promise<Reply> } | null = null;
  let townLogAt = 0;
  const town = (): Promise<Reply> => {
    if (townCache && Date.now() - townCache.at < TOWN_CACHE_MS) return townCache.reply;
    const reply = fetchTownFeed(townUrl, townToken).then((r) => {
      // One line a minute at most, without the address (it may hold a secret).
      if (r[0] !== 200 && Date.now() - townLogAt > 60_000) {
        townLogAt = Date.now();
        opts.log(`mini app: town feed: ${str(r[1].error)}${r[1].detail ? ` (${str(r[1].detail)})` : ""}`);
      }
      return r;
    });
    townCache = { at: Date.now(), reply };
    return reply;
  };

  const touch = () => {
    if (!worker) {
      worker = new Worker(new URL(import.meta.url).href);
      worker.onmessage = (ev: MessageEvent) => {
        if (ev.data?.type === "snapshot") snapshot = ev.data.snapshot;
      };
      worker.onerror = (ev) => {
        opts.log(`mini app: worker failed: ${ev.message}`);
        worker?.terminate();
        worker = null;
      };
    }
    worker.postMessage({ type: "touch" });
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const telegramUser = telegramUserOf(opts.token, opts.isAllowed);

  const isPeer = (req: Request) =>
    !!peerSecret && sameSecret(req.headers.get("authorization") ?? "", `Bearer ${peerSecret}`);

  const controlOff = process.env.TELEGRAM_MINIAPP_CONTROL === "off";
  const offHere = { enabled: false, reason: "Session controls are turned off on that machine." };
  const controlFor = (userId: string): { enabled: boolean; reason?: string } => {
    if (controlOff)
      return { enabled: false, reason: "Session controls are turned off (TELEGRAM_MINIAPP_CONTROL=off)." };
    return opts.canControl?.(userId)
      ? { enabled: true }
      : { enabled: false, reason: "Only admins can control sessions." };
  };
  // Sessions keep their actions only when the user may use them.
  const withControl = (data: any, control: { enabled: boolean; reason?: string }) => ({
    ...data,
    control,
    sessions: Array.isArray(data.sessions)
      ? data.sessions.map((s: any) => ({ ...s, actions: control.enabled && Array.isArray(s.actions) ? s.actions : [] }))
      : data.sessions,
  });

  // Asks another machine, only one from TELEGRAM_MINIAPP_PEERS, so the board never fetches an address from the request.
  const askPeer = async (machine: string, path: string, init: RequestInit, timeoutMs: number): Promise<Reply> => {
    const base = peers.get(machine);
    if (!base) return [404, { error: "unknown machine" }];
    try {
      const res = await globalThis.fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${peerSecret}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json();
      // 401 means the machines do not share the secret: for the user that machine is unreachable.
      if (res.status === 401 || !body || typeof body !== "object") throw new Error(`HTTP ${res.status}`);
      return [res.status, body];
    } catch {
      return [502, { error: "unreachable", machine }];
    }
  };

  const messages = async (url: URL): Promise<Reply> => {
    const id = url.searchParams.get("id") ?? "";
    if (!SESSION_ID.test(id)) return [400, { error: "id must be a session id" }];
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);
    const path = transcriptPath(id);
    if (!path) return [404, { error: "no transcript for this session" }];
    try {
      return [200, { messages: await readMessages(path, limit) }];
    } catch {
      return [502, { error: "cannot read the transcript" }];
    }
  };

  // Tasks started from the board: the requester gets a message when the session stops working.
  // Kept in a file, because the daemon restarts every few hours.
  const tasksFile = opts.dataDir ? join(opts.dataDir, "miniapp-tasks.json") : "";
  let tasks: Task[] = [];
  try {
    const saved = JSON.parse(readFileSync(tasksFile, "utf8"));
    if (Array.isArray(saved)) tasks = saved.filter((t) => typeof t?.id === "string" && Date.now() - t.startedAt < DAY);
  } catch {}
  let taskTimer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  const saveTasks = () => {
    try {
      if (tasksFile) writeFileSync(tasksFile, JSON.stringify(tasks));
    } catch {}
  };
  const checkTasks = async () => {
    if (checking) return;
    checking = true;
    try {
      const list = await agentsList();
      if (!list) return;
      const now = Date.now();
      const done = new Set<Task>();
      for (const t of tasks) {
        const s = list.find((x) => x.id === t.id || x.sessionId.startsWith(t.id));
        // A background session stays alive after its turn, in state "done". Right after the start the
        // list may not show it yet.
        const working = s
          ? !!s.pid && (s.state ? s.state === "working" : s.status === "busy")
          : now - t.startedAt < 60_000;
        if (working) {
          if (now - t.startedAt > DAY) done.add(t);
          continue;
        }
        done.add(t);
        try {
          await opts.notify?.(t.userId, `Task finished in ${t.project}: ${t.prompt}. Open /agents to read it.`);
        } catch (err) {
          opts.log(`mini app: task notice for ${t.id} failed: ${err}`);
        }
      }
      if (done.size) {
        tasks = tasks.filter((t) => !done.has(t));
        saveTasks();
      }
    } finally {
      checking = false;
      if (!tasks.length && taskTimer) {
        clearInterval(taskTimer);
        taskTimer = null;
      }
    }
  };
  const watchTasks = () => {
    if (!taskTimer && tasks.length) taskTimer = setInterval(() => void checkTasks(), 15_000);
  };

  const backgroundId = (out: string) => /backgrounded\W+([0-9a-f]{8})/.exec(out)?.[1];
  const cliError = (out: string) =>
    firstLine(
      out
        .replace(ANSI_REST, "")
        .split("\n")
        .filter((l) => !/^\s*Starting background service/.test(l))
        .join("\n"),
    ) || "claude failed";

  // One control action on this machine. fromPeer: another machine's board asked, so no task notice here.
  const runControl = async (body: Record<string, unknown>, userId: string, fromPeer: boolean): Promise<Reply> => {
    const action = str(body.action);
    if (action === "bot-new") {
      if (!opts.newSession) return [409, { error: "This board cannot start a new bot session." }];
      try {
        opts.newSession();
      } catch (err) {
        return [502, { error: `Could not signal a restart: ${err}` }];
      }
      return [200, { ok: true, message: "Starting a fresh bot session. Memory is kept. Back in a minute." }];
    }

    if (action === "new") {
      const cwd = str(body.cwd);
      const prompt = str(body.prompt);
      const mode = str(body.mode) || "default";
      if (!MODES.has(mode)) return [400, { error: "mode must be plan, acceptEdits or default" }];
      if (!prompt.trim() || prompt.length > MAX_TEXT)
        return [400, { error: `prompt needs 1 to ${MAX_TEXT} characters` }];
      if (!snapshot) {
        touch();
        return [409, { error: "The board is still loading. Try again in a few seconds." }];
      }
      if (!snapshot.projects.some((p) => p.cwd === cwd))
        return [400, { error: "cwd is not one of the board's projects" }];
      // "--" ends the options, so a prompt that starts with "-" stays a prompt.
      const r = await runClaude(["--bg", "--permission-mode", mode, "--", prompt.trim()], cwd);
      const id = backgroundId(r.out);
      if (!id) return [502, { error: cliError(r.out) }];
      const project = projectName(cwd);
      const notice = !fromPeer && !!opts.notify;
      if (notice) {
        tasks.push({ id, userId, project, prompt: clip(prompt, 80), startedAt: Date.now() });
        saveTasks();
        watchTasks();
      }
      return [
        200,
        { ok: true, id, message: `Started in ${project}.${notice ? " You get a message when it finishes." : ""}` },
      ];
    }

    if (!["send", "stop", "logs", "rm", "interrupt", "terminate"].includes(action))
      return [400, { error: "unknown action" }];
    const id = str(body.id);
    if (!SESSION_ID.test(id)) return [400, { error: "id must be a session id" }];
    // Look the session up now, never from the snapshot: the pid and state must be current.
    const list = await agentsList();
    if (!list) return [502, { error: "claude agents failed" }];
    const s = list.find((x) => x.sessionId === id);
    if (!s) return [404, { error: "session not found" }];
    const name = s.name || id.slice(0, 8);
    const short = s.id || id.slice(0, 8);
    const background = s.kind === "background";
    const own = !!s.pid && ancestorPids().has(s.pid);

    if (action === "send") {
      if (own) return [403, { error: "This is the bot's own session. Write to the bot in Telegram instead." }];
      const text = str(body.text);
      if (!text.trim() || text.length > MAX_TEXT) return [400, { error: `text needs 1 to ${MAX_TEXT} characters` }];
      if (!s.cwd || !existsSync(s.cwd)) return [409, { error: "The session's folder no longer exists." }];
      if (background && s.pid && s.state !== "working") {
        // A background session that finished its turn keeps running, and --resume would start a copy.
        // Stop it first (the conversation is kept), so the message continues the same session. The list
        // drops the pid before the process exits, so wait for the process itself.
        await runClaude(["stop", short]);
        for (let i = 0; i < 20 && Bun.spawnSync(["ps", "-p", String(s.pid)]).exitCode === 0; i++) await Bun.sleep(250);
      }
      const r = await runClaude(["--bg", "--resume", id, "--", text.trim()], s.cwd);
      const bg = backgroundId(r.out);
      if (!bg) return [502, { error: cliError(r.out) }];
      const copy = /started a copy/.test(r.out);
      const message = copy
        ? `${name} is still running, so Claude started a copy (${bg}) with your message.`
        : `Sent. ${name} continues in the background.`;
      return [200, { ok: true, id: bg, message }];
    }

    if (action === "stop" || action === "rm" || action === "logs") {
      if (!background) return [409, { error: "Only background sessions have stop, logs and remove." }];
      if (action === "stop" && !s.pid) return [409, { error: "The session is already stopped." }];
      if (action === "rm" && s.pid) return [409, { error: "Stop the session before you remove it." }];
      const r = await runClaude([action, short]);
      if (/No job matching/.test(r.out)) return [404, { error: "session not found" }];
      if (action === "logs") {
        if (r.code !== 0) return [502, { error: cliError(r.out) }];
        return [
          200,
          { ok: true, id: short, message: `Recent output of ${name}.`, output: plainLogs(r.stdout).slice(-8000) },
        ];
      }
      if (!new RegExp(`^${action === "stop" ? "stopped" : "removed"} `, "m").test(r.out))
        return [502, { error: cliError(r.out) }];
      const message = action === "stop" ? `Stopped ${name}. The conversation is kept.` : `Removed ${name}.`;
      return [200, { ok: true, id: short, message }];
    }

    // interrupt, terminate: terminal sessions only, by signal.
    if (background) return [409, { error: "Background sessions are stopped with stop, not signalled." }];
    if (!s.pid) return [409, { error: "The session is not running." }];
    if (own) return [403, { error: "The board never signals the bot's own session." }];
    // The pid can be reused once the session exits: check that it still runs claude.
    const cmd = Bun.spawnSync(["ps", "-p", String(s.pid), "-o", "command="]).stdout.toString();
    if (!/^(\S*\/)?claude(\s|$)/.test(cmd)) return [409, { error: "The session is not running." }];
    try {
      process.kill(s.pid, action === "interrupt" ? "SIGINT" : "SIGTERM");
    } catch (err) {
      return [502, { error: `Could not signal the session: ${err}` }];
    }
    // Tested with Claude Code 2.1.296: SIGINT makes an interactive session quit, busy or idle, and a reply
    // in progress is lost. SIGTERM quits at once. Either way the transcript stays and --resume continues it.
    const message =
      action === "interrupt"
        ? `Sent SIGINT. ${name} quits: Claude Code exits on SIGINT, busy or idle, and a reply in progress is lost. The conversation is kept, claude --resume ${id} continues it.`
        : `Sent SIGTERM. ${name} quits at once. The conversation is kept, claude --resume ${id} continues it.`;
    return [200, { ok: true, message }];
  };

  const logControl = (body: Record<string, unknown>, userId: string, machine: string, status: number) => {
    const target = str(body.id) || str(body.cwd) || "-";
    opts.log(
      `mini app: control ${clip(str(body.action), 20) || "-"} ${clip(target, 200)} by ${userId} on ${clip(machine, 40)} -> ${status < 300 ? "ok" : "error"}`,
    );
  };

  const recent = new Map<string, number[]>();
  const overRate = (userId: string) => {
    const now = Date.now();
    const times = (recent.get(userId) ?? []).filter((t) => now - t < 60_000);
    const over = times.length >= CONTROLS_PER_MINUTE;
    if (!over) times.push(now);
    recent.set(userId, times);
    return over;
  };

  const controlRoute = async (req: Request, url: URL): Promise<Response> => {
    const userId = telegramUser(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const body = await readJsonBody(req);
    if (typeof body === "string") return json({ error: body }, 400);
    const machine = url.searchParams.get("machine") || "local";
    const control = controlFor(userId);
    const [status, reply]: Reply = !control.enabled
      ? [403, { error: control.reason }]
      : overRate(userId)
        ? [429, { error: `At most ${CONTROLS_PER_MINUTE} actions per minute. Try again shortly.` }]
        : machine === "local"
          ? await runControl(body, userId, false)
          : // The CLI call on that machine can take up to 20 s, longer than the 5 s for reads.
            await askPeer(
              machine,
              "/api/peer/control",
              {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Telegram-User": userId },
                body: JSON.stringify(body),
              },
              25_000,
            );
    logControl(body, userId, machine, status);
    return json(reply, status);
  };

  const peerControlRoute = async (req: Request): Promise<Response> => {
    if (!isPeer(req)) return json({ error: "unauthorized" }, 401);
    const body = await readJsonBody(req);
    if (typeof body === "string") return json({ error: body }, 400);
    // The user id is for the log only: the other board already checked who may control.
    const header = req.headers.get("x-telegram-user") ?? "";
    const userId = `peer:${/^\d{1,20}$/.test(header) ? header : "?"}`;
    const [status, reply]: Reply = controlOff ? [403, { error: offHere.reason }] : await runControl(body, userId, true);
    logControl(body, userId, "local", status);
    return json(reply, status);
  };

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    if (opts.webhook && pathname === "/telegram/webhook") {
      return req.method === "POST" ? opts.webhook(req) : new Response("Method not allowed", { status: 405 });
    }
    if (!board) return new Response("Not found", { status: 404 });
    if (pathname === "/api/control" || pathname === "/api/peer/control") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return pathname === "/api/control" ? controlRoute(req, url) : peerControlRoute(req);
    }
    const needsReply = await needsRoute(req, pathname, telegramUser, opts.needs, opts.log);
    if (needsReply) return needsReply;
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (pathname === "/" || pathname === "/index.html") {
      try {
        return new Response(readFileSync(htmlPath), { headers: HTML_HEADERS });
      } catch {
        return new Response("miniapp/index.html is missing next to server.ts", { status: 500 });
      }
    }
    if (pathname === "/api/state") {
      const userId = telegramUser(req);
      if (!userId) return json({ error: "unauthorized" }, 401);
      const control = controlFor(userId);
      const machine = url.searchParams.get("machine") || "local";
      if (machine !== "local") {
        const [status, data] = await askPeer(machine, "/api/peer/state", {}, 5000);
        if (status !== 200) return json({ ...data, machine, machines }, status === 404 ? 404 : 502);
        // A machine that runs a version without controls, or has them turned off, stays read-only.
        const remote =
          !control.enabled || (data.control as any)?.enabled
            ? control
            : {
                enabled: false,
                reason: str((data.control as any)?.reason) || "That machine runs a version without session controls.",
              };
        return json({ ...withControl(data, remote), town: data.town === true, machine, machines });
      }
      touch();
      return json({ ...withControl(snapshot ?? { loading: true }, control), town: !!townUrl, machine, machines });
    }
    if (pathname === "/api/town") {
      const userId = telegramUser(req);
      if (!userId) return json({ error: "unauthorized" }, 401);
      const machine = url.searchParams.get("machine") || "local";
      if (machine !== "local") {
        const [status, body] = await askPeer(machine, "/api/peer/town", {}, 5000);
        return json({ ...body, machine }, status === 200 ? 200 : status === 404 ? 404 : 502);
      }
      if (!townUrl) return json({ error: "no town feed" }, 404);
      const [status, body] = await town();
      return json(body, status);
    }
    if (pathname === "/api/session/messages") {
      const userId = telegramUser(req);
      if (!userId) return json({ error: "unauthorized" }, 401);
      const control = controlFor(userId);
      if (!control.enabled) return json({ error: control.reason }, 403);
      const machine = url.searchParams.get("machine") || "local";
      const query = new URLSearchParams({
        id: url.searchParams.get("id") ?? "",
        limit: url.searchParams.get("limit") ?? "30",
      });
      const [status, body] =
        machine === "local"
          ? await messages(url)
          : await askPeer(machine, `/api/peer/messages?${query}`, { headers: { "X-Telegram-User": userId } }, 5000);
      return json(body, status);
    }
    if (pathname === "/api/peer/state") {
      // Another machine's board reads this machine's snapshot. Actions are there as if control were on;
      // that board removes them for users who may not control.
      if (!isPeer(req)) return json({ error: "unauthorized" }, 401);
      touch();
      return json({
        ...withControl(snapshot ?? { loading: true }, controlOff ? offHere : { enabled: true }),
        town: !!townUrl,
      });
    }
    if (pathname === "/api/peer/town") {
      if (!isPeer(req)) return json({ error: "unauthorized" }, 401);
      if (!townUrl) return json({ error: "no town feed" }, 404);
      const [status, body] = await town();
      return json(body, status);
    }
    if (pathname === "/api/peer/messages") {
      if (!isPeer(req)) return json({ error: "unauthorized" }, 401);
      if (controlOff) return json({ error: offHere.reason }, 403);
      const [status, body] = await messages(url);
      return json(body, status);
    }
    return new Response("Not found", { status: 404 });
  };

  // After a restart or a lock takeover the old process can hold the port for a few seconds. A process
  // that dropped to MCP-only mode can hold it until it exits, so keep trying, less often after 30 s.
  const listen = (attempt: number) => {
    try {
      Bun.serve({ hostname: host, port, fetch });
      if (!board) {
        opts.log(`webhook: listening on ${host}:${port} (agents board off)`);
        return;
      }
      opts.log(`mini app: listening on ${host}:${port}${miniAppUrl() ? `, public URL ${miniAppUrl()}` : ""}`);
      if (peers.size) opts.log(`mini app: other machines: ${[...peers.keys()].join(", ")}`);
      if (isAuto()) startQuickTunnel(port, opts.log);
    } catch (err) {
      if (attempt === 20) opts.log(`mini app: cannot listen on ${host}:${port}: ${err}. Trying again every 15 s.`);
      setTimeout(() => listen(attempt + 1), attempt < 20 ? 1500 : 15_000);
    }
  };
  if (board) watchTasks();
  listen(1);
}

// ── Worker thread: read sessions and transcripts, post snapshots ─────

const TICK_MS = 4000;
const ACTIVE_MS = 5 * 60_000;
const CHUNK = 8 << 20;
const MAX_ACTIVITY = 30;
const HIDDEN_TOOLS = new Set(["SubagentHandback"]);
const LOOK_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "ToolSearch", "NotebookRead"]);
const MAX_STEPS = 6;

interface FileState {
  offset: number;
  rest: Uint8Array;
  ids: Map<string, { u: Usage; t: number }>;
  tokens: Usage;
  model: string | null;
  contextTokens: number;
  toolCalls: number;
  pending: Map<string, ToolRef>;
  lastTool: ToolRef | null;
  lastKind: string;
  handback: boolean;
  firstTs: number;
  lastTs: number;
  cwd: string;
  turn: TurnView | null;
}

interface Located {
  path: string;
  mtime: number;
}

interface SubagentFile extends Located {
  id: string;
  type: string;
  description: string;
}

interface LiveSession {
  sessionId: string;
  name?: string;
  cwd?: string;
  kind?: string;
  status?: string;
  /** Background sessions: working, done or stopped. */
  state?: string;
  waitingFor?: string;
  startedAt?: number;
  /** Missing for a background session that was stopped. */
  pid?: number;
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addUsage = (a: Usage, b: Usage) => {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheWrite += b.cacheWrite;
};

function clip(s: unknown, n: number): string {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The text of a prompt as a person reads it: a Telegram message without the channel tag and the
// history the plugin appends, a slash command as "/name args".
function promptText(content: unknown): string {
  let text = typeof content === "string" ? content : "";
  if (Array.isArray(content)) {
    for (const c of content) if (c?.type === "text" && typeof c.text === "string") text += `${c.text} `;
  }
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) text = `${cmd[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ""}`;
  text = text.split("\n\n[Recent history")[0].replace(/<[^>]+>/g, " ");
  return clip(text, 200);
}

// Short target for a tool call, the same idea as scripts/telegram-progress-hook.ts.
function describe(tool: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.notebook_path ?? input.path;
  const file = typeof path === "string" ? path : undefined;
  switch (tool) {
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return file ? basename(file) : "";
    case "Bash":
      return clip(input.description ?? input.command, 60);
    case "Grep":
    case "Glob":
      return clip(input.pattern, 50);
    case "WebFetch":
      return clip(String(input.url ?? "").replace(/^https?:\/\//, ""), 60);
    case "WebSearch":
      return clip(input.query, 60);
    case "Agent":
    case "Task":
      return clip(input.description, 60);
    case "Skill":
      return clip(input.skill, 40);
    default:
      // The Telegram reply tools: the message text says more than the tool name.
      return /__(reply|voice_reply)$/.test(tool) ? clip(input.text, 60) : "";
  }
}

// The name shown in the header: TELEGRAM_MINIAPP_NAME, else the macOS computer name, else the host name.
function machineName(): string {
  if (process.env.TELEGRAM_MINIAPP_NAME) return process.env.TELEGRAM_MINIAPP_NAME;
  if (process.platform === "darwin") {
    try {
      const name = Bun.spawnSync(["scutil", "--get", "ComputerName"]).stdout.toString().trim();
      if (name) return name;
    } catch {}
  }
  return hostname().replace(/\.local$/, "");
}

function projectName(cwd: string): string {
  return cwd === (userInfo().homedir || homedir()) ? "~" : basename(cwd) || "~";
}

function sessionStatus(s: LiveSession): SessionView["status"] {
  if (s.kind === "background" && !s.pid) return "stopped";
  if (s.status === "waiting") return "waiting";
  return s.status === "busy" || s.state === "working" ? "busy" : "idle";
}

// What the board may offer for a session, as if the user may control. The main thread removes them otherwise.
function sessionActions(s: LiveSession): string[] {
  if (s.pid && ancestorPids().has(s.pid)) return ["peek", "bot-new"];
  if (s.kind === "background") return s.pid ? ["peek", "send", "stop", "logs"] : ["peek", "send", "logs", "rm"];
  return ["peek", "send", "interrupt", "terminate"];
}

// Claude 5 models have a 1M window by default. Haiku and older models (claude-3-*, claude-opus-4-*)
// have 200K, unless the session already used more, which means it runs with the 1M option.
function contextWindow(model: string | null, used: number): number {
  const small = /haiku|^claude-(?:\d|[a-z]+-[1-4](?:-|$))/i.test(model ?? "");
  return small && used <= 200_000 ? 200_000 : 1_000_000;
}

function runWorker(post: (msg: unknown) => void, onTouch: (fn: () => void) => void): void {
  const root = projectsRoot();
  const files = new Map<string, FileState>();
  const owner = new Map<string, { sessionId: string; agent: string | null }>();
  const hourly = new Map<number, Usage & { tools: number }>();
  let activity: Activity[] = [];
  let names = new Map<string, string>();
  let activeUntil = 0;
  let running = false;
  let ready = false;
  const decoder = new TextDecoder();
  const host = machineName();
  const metas = new Map<string, { agentType?: string; description?: string }>();
  // The cwd of each transcript of the last 7 days, for the new-task picker.
  const heads = new Map<string, string>();
  let allFlag = true;
  let fromCli = true;

  onTouch(() => {
    activeUntil = Date.now() + ACTIVE_MS;
    if (!running) void loop();
  });

  async function loop() {
    running = true;
    try {
      while (Date.now() < activeUntil) {
        try {
          await tick();
        } catch {
          // A failed tick must not stop the loop. The next tick starts again from the saved offsets.
        }
        await Bun.sleep(TICK_MS);
      }
    } finally {
      running = false;
    }
  }

  // --all adds stopped background sessions, which can still be read or removed. Older CLIs lack the flag.
  async function listSessions(): Promise<LiveSession[] | null> {
    const list = await runAgents(allFlag);
    if (list || !allFlag) return list;
    const plain = await runAgents(false);
    if (plain) allFlag = false;
    return plain;
  }

  async function runAgents(all: boolean): Promise<LiveSession[] | null> {
    try {
      const proc = Bun.spawn(["claude", "agents", "--json", ...(all ? ["--all"] : [])], {
        stdout: "pipe",
        stderr: "ignore",
      });
      // Limit the read itself: a child that ignores SIGTERM or leaves the pipe open must not hang the tick.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve(null);
        }, 10_000);
      });
      const out = await Promise.race([new Response(proc.stdout).text(), timeout]).finally(() => clearTimeout(timer));
      if (out === null) return null;
      const list = JSON.parse(out);
      return Array.isArray(list) ? list.filter((s) => typeof s?.sessionId === "string") : null;
    } catch {
      return null;
    }
  }

  // Index the transcripts: main session files by session id, subagent files by parent session.
  function discover(): { mains: Map<string, Located>; subs: Map<string, SubagentFile[]> } {
    const mains = new Map<string, Located>();
    const subs = new Map<string, SubagentFile[]>();
    let projects: string[] = [];
    try {
      projects = readdirSync(root);
    } catch {
      return { mains, subs };
    }
    for (const p of projects) {
      const dir = join(root, p);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        const path = join(dir, name);
        if (name.endsWith(".jsonl")) {
          try {
            mains.set(name.slice(0, -6), { path, mtime: statSync(path).mtimeMs });
          } catch {}
          continue;
        }
        if (name.includes(".")) continue;
        const subDir = join(path, "subagents");
        let agentFiles: string[];
        try {
          agentFiles = readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          continue;
        }
        const list: SubagentFile[] = [];
        for (const f of agentFiles) {
          const fp = join(subDir, f);
          let meta = metas.get(fp);
          if (!meta) {
            try {
              meta = JSON.parse(readFileSync(fp.replace(/\.jsonl$/, ".meta.json"), "utf8"));
            } catch {}
            meta ??= {};
            if (meta.agentType) metas.set(fp, meta);
          }
          try {
            list.push({
              path: fp,
              mtime: statSync(fp).mtimeMs,
              id: f.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
              type: meta.agentType ?? "agent",
              description: meta.description ?? "",
            });
          } catch {}
        }
        subs.set(name, list);
      }
    }
    return { mains, subs };
  }

  function bucket(t: number) {
    const key = t - (t % HOUR);
    let b = hourly.get(key);
    if (!b) {
      b = { ...zero(), tools: 0 };
      hourly.set(key, b);
    }
    return b;
  }

  function ingest(path: string, f: FileState, line: string, now: number) {
    const isAssistant = line.includes('"type":"assistant"');
    if (!isAssistant && !line.includes('"type":"user"')) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const t = Date.parse(e.timestamp) || 0;
    if (t) {
      if (!f.firstTs) f.firstTs = t;
      if (t > f.lastTs) f.lastTs = t;
    }
    if (!f.cwd && typeof e.cwd === "string") f.cwd = e.cwd;
    const m = e.message;
    if (!m || typeof m !== "object") return;
    const recent = t > now - DAY;
    if (e.type === "assistant") {
      if (m.model && m.model !== "<synthetic>") f.model = m.model;
      const u = m.usage;
      // Claude Code writes one line per content block with the same message id. Later lines can
      // carry a larger output_tokens, so keep the highest value per field and count only the growth.
      if (u && m.id) {
        const usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        };
        let seen = f.ids.get(m.id);
        if (!seen) {
          seen = { u: zero(), t };
          f.ids.set(m.id, seen);
        }
        const growth = {
          input: Math.max(0, usage.input - seen.u.input),
          output: Math.max(0, usage.output - seen.u.output),
          cacheRead: Math.max(0, usage.cacheRead - seen.u.cacheRead),
          cacheWrite: Math.max(0, usage.cacheWrite - seen.u.cacheWrite),
        };
        addUsage(seen.u, growth);
        addUsage(f.tokens, growth);
        if (seen.t > now - DAY) addUsage(bucket(seen.t), growth);
        f.contextTokens = seen.u.input + seen.u.cacheRead + seen.u.cacheWrite;
      }
      const turn = f.turn;
      if (turn && t) turn.endedAt = Math.max(turn.endedAt, t);
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== "object") continue;
        f.lastKind = c.type;
        if (c.type === "text" && turn && typeof c.text === "string" && c.text.trim()) {
          turn.text = clip(c.text, 240);
          step(turn, { t, text: clip(c.text, 120) });
        }
        if (c.type !== "tool_use" || !c.id || f.pending.has(c.id)) continue;
        if (c.name === "SubagentHandback") f.handback = true;
        if (HIDDEN_TOOLS.has(c.name)) continue;
        const ref = { name: String(c.name), target: describe(c.name, c.input ?? {}), t };
        f.pending.set(c.id, ref);
        f.lastTool = ref;
        f.toolCalls++;
        if (turn) {
          if (LOOK_TOOLS.has(ref.name) || /__(search|get|read|list|fetch|query)/i.test(ref.name)) turn.searches++;
          else turn.tools++;
          step(turn, { t, text: ref.target, tool: ref.name });
        }
        if (recent) {
          bucket(t).tools++;
          const who = owner.get(path);
          if (who) {
            activity.push({
              t,
              sessionId: who.sessionId,
              session: names.get(who.sessionId) ?? (f.cwd ? projectName(f.cwd) : who.sessionId.slice(0, 8)),
              agent: who.agent,
              tool: ref.name,
              target: ref.target,
            });
          }
        }
      }
    } else if (e.type === "user") {
      let result = false;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c?.type !== "tool_result") continue;
          f.pending.delete(c.tool_use_id);
          result = true;
        }
      }
      // A new prompt starts a turn: typed by a person, a Telegram message, or a message from another
      // session. Skill text, other isMeta lines without an origin and background task notices belong to
      // the turn they are in.
      const origin = e.origin?.kind;
      const prompt = !result && !e.isCompactSummary && !e.isSidechain && (origin ? origin !== "task-notification" : !e.isMeta);
      if (prompt && t) {
        f.turn = { prompt: promptText(m.content), text: "", startedAt: t, endedAt: t, searches: 0, tools: 0, steps: [] };
      }
    }
  }

  function step(turn: TurnView, s: Step) {
    turn.steps.push(s);
    if (turn.steps.length > MAX_STEPS) turn.steps.shift();
  }

  async function readNew(path: string, now: number) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    let f = files.get(path);
    if (!f || size < f.offset) {
      f = {
        offset: 0,
        rest: new Uint8Array(0),
        ids: new Map(),
        tokens: zero(),
        model: null,
        contextTokens: 0,
        toolCalls: 0,
        pending: new Map(),
        lastTool: null,
        lastKind: "",
        handback: false,
        firstTs: 0,
        lastTs: 0,
        cwd: "",
        turn: null,
      };
      files.set(path, f);
    }
    while (f.offset < size) {
      const end = Math.min(size, f.offset + CHUNK);
      const chunk = new Uint8Array(await Bun.file(path).slice(f.offset, end).arrayBuffer());
      f.offset = end;
      const buf = f.rest.length ? Buffer.concat([f.rest, chunk]) : chunk;
      const nl = buf.lastIndexOf(10);
      if (nl < 0) {
        f.rest = buf;
        continue;
      }
      // Copy the tail. Buffer.slice returns a view, which keeps the whole read buffer in memory.
      f.rest = new Uint8Array(buf.subarray(nl + 1));
      for (const line of decoder.decode(buf.subarray(0, nl)).split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          ingest(path, f, line, now);
        } catch {
          // Skip a record with an unexpected shape, so one bad line cannot stop the board.
        }
      }
      if (!ready) await Bun.sleep(0);
    }
  }

  function currentTool(f: FileState | undefined, now: number): ToolRef | null {
    if (!f) return null;
    let latest: ToolRef | null = null;
    for (const ref of f.pending.values()) if (now - ref.t < HOUR && (!latest || ref.t > latest.t)) latest = ref;
    return latest;
  }

  function agentView(a: SubagentFile, now: number): AgentView {
    const f = files.get(a.path);
    const last = f?.lastTs || a.mtime;
    const idle = now - last;
    const finished = f?.handback || (f?.lastKind === "text" && !f.pending.size && idle > 30_000) || idle > 15 * 60_000;
    return {
      id: a.id,
      type: a.type,
      description: a.description,
      status: finished ? "done" : "running",
      model: f?.model ?? null,
      tokens: f?.tokens ?? zero(),
      toolCalls: f?.toolCalls ?? 0,
      currentTool: finished ? null : currentTool(f, now),
      lastTool: f?.lastTool ?? null,
      startedAt: f?.firstTs || a.mtime,
      lastActivity: last,
    };
  }

  function build(now: number, live: LiveSession[], idx: ReturnType<typeof discover>): Snapshot {
    const sessions: SessionView[] = live.map((s) => {
      const main = idx.mains.get(s.sessionId);
      const f = main ? files.get(main.path) : undefined;
      const all = (idx.subs.get(s.sessionId) ?? []).map((a) => agentView(a, now));
      const agents = all
        .filter((a) => a.status === "running" || now - a.lastActivity < 6 * HOUR)
        .sort(
          (a, b) => Number(b.status === "running") - Number(a.status === "running") || b.lastActivity - a.lastActivity,
        )
        .slice(0, 8);
      const cwd = s.cwd ?? "";
      const lastActivity = Math.max(f?.lastTs ?? 0, ...all.map((a) => a.lastActivity));
      return {
        id: s.sessionId,
        name: s.name ?? s.sessionId.slice(0, 8),
        project: projectName(cwd),
        cwd,
        kind: s.kind ?? "interactive",
        status: sessionStatus(s),
        waitingFor: sessionStatus(s) === "waiting" ? clip(s.waitingFor || "input needed", 40) : null,
        startedAt: s.startedAt ?? f?.firstTs ?? now,
        model: f?.model ?? null,
        contextTokens: f?.contextTokens ?? 0,
        contextWindow: contextWindow(f?.model ?? null, f?.contextTokens ?? 0),
        tokens: f?.tokens ?? zero(),
        toolCalls: f?.toolCalls ?? 0,
        currentTool: sessionStatus(s) === "busy" ? currentTool(f, now) : null,
        lastTool: f?.lastTool ?? null,
        lastActivity: lastActivity || s.startedAt || now,
        agents,
        agentsTotal: all.length,
        turn: f?.turn ? { ...f.turn, steps: [...f.turn.steps] } : null,
        actions: fromCli ? sessionActions(s) : ["peek"],
      };
    });
    // Busy first in a stable order, so cards do not jump on every poll; idle ones by last activity,
    // stopped ones last.
    const rank = { waiting: 0, busy: 1, idle: 2, stopped: 3 };
    sessions.sort((a, b) =>
      a.status !== b.status
        ? rank[a.status] - rank[b.status]
        : a.status === "busy"
          ? a.startedAt - b.startedAt
          : b.lastActivity - a.lastActivity,
    );

    const hourNow = now - (now % HOUR);
    const series: Snapshot["hourly"] = [];
    for (let k = 23; k >= 0; k--) {
      const t = hourNow - k * HOUR;
      series.push({ t, ...(hourly.get(t) ?? { ...zero(), tools: 0 }) });
    }
    for (const key of hourly.keys()) if (key < hourNow - 25 * HOUR) hourly.delete(key);
    const tokens24h = zero();
    let toolCalls24h = 0;
    for (const h of series) {
      addUsage(tokens24h, h);
      toolCalls24h += h.tools;
    }
    let agents24h = 0;
    for (const list of idx.subs.values()) for (const a of list) if (a.mtime > now - DAY) agents24h++;

    activity = activity
      .filter((a) => a.t > now - DAY)
      .sort((a, b) => b.t - a.t)
      .slice(0, MAX_ACTIVITY);

    const used = new Map<string, number>();
    const use = (cwd: string, t: number) => {
      if (cwd && t > (used.get(cwd) ?? 0)) used.set(cwd, t);
    };
    for (const s of sessions) use(s.cwd, s.lastActivity);
    for (const l of idx.mains.values()) if (l.mtime > now - 7 * DAY) use(heads.get(l.path) ?? "", l.mtime);
    const projects = [...used]
      .sort((a, b) => b[1] - a[1])
      .map(([cwd]) => cwd)
      .filter((cwd) => existsSync(cwd))
      .slice(0, 30)
      .map((cwd) => ({ cwd, name: projectName(cwd) }));

    return {
      now,
      host,
      ready,
      totals: {
        sessions: sessions.filter((s) => s.status !== "stopped").length,
        busy: sessions.filter((s) => s.status === "busy").length,
        waiting: sessions.filter((s) => s.status === "waiting").length,
        agentsRunning: sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === "running").length, 0),
        agents24h,
        toolCalls24h,
        tokens24h,
      },
      hourly: series,
      sessions,
      activity,
      projects,
    };
  }

  async function tick() {
    const now = Date.now();
    const idx = discover();
    let live = await listSessions();
    fromCli = !!live;
    if (!live) {
      // No `claude` on PATH: treat transcripts written in the last 15 minutes as live sessions.
      live = [...idx.mains.entries()]
        .filter(([, l]) => now - l.mtime < 15 * 60_000)
        .map(([sessionId, l]) => ({ sessionId, status: now - l.mtime < 30_000 ? "busy" : "idle" }));
    }
    names = new Map(live.map((s) => [s.sessionId, s.name ?? s.sessionId.slice(0, 8)]));

    // Live sessions first, so the first snapshots already show them.
    const order: string[] = [];
    const seen = new Set<string>();
    const want = (path: string, sessionId: string, agent: string | null) => {
      if (seen.has(path)) return;
      seen.add(path);
      owner.set(path, { sessionId, agent });
      order.push(path);
    };
    for (const s of live) {
      const main = idx.mains.get(s.sessionId);
      if (main) want(main.path, s.sessionId, null);
      for (const a of idx.subs.get(s.sessionId) ?? []) want(a.path, s.sessionId, a.type);
    }
    for (const [sessionId, l] of idx.mains) if (l.mtime > now - DAY) want(l.path, sessionId, null);
    for (const [sessionId, list] of idx.subs)
      for (const a of list) if (a.mtime > now - DAY) want(a.path, sessionId, a.type);

    let lastPost = 0;
    for (const path of order) {
      try {
        await readNew(path, now);
      } catch {
        // The file was deleted or cannot be read. Skip it for this tick.
      }
      if (!ready && Date.now() - lastPost > 1500) {
        post({ type: "snapshot", snapshot: build(Date.now(), live, idx) });
        lastPost = Date.now();
      }
    }
    ready = true;
    for (const [, l] of idx.mains) {
      if (l.mtime < now - 7 * DAY || heads.has(l.path)) continue;
      let cwd = files.get(l.path)?.cwd ?? "";
      if (!cwd) {
        try {
          const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(
            await Bun.file(l.path)
              .slice(0, 64 << 10)
              .text(),
          );
          if (m) cwd = JSON.parse(`"${m[1]}"`);
        } catch {}
      }
      heads.set(l.path, cwd);
    }
    post({ type: "snapshot", snapshot: build(Date.now(), live, idx) });
    for (const path of files.keys()) {
      if (seen.has(path)) continue;
      files.delete(path);
      owner.delete(path);
    }
  }
}

if (!Bun.isMainThread) {
  const scope = globalThis as unknown as {
    postMessage: (msg: unknown) => void;
    onmessage: ((ev: MessageEvent) => void) | null;
  };
  runWorker(
    (msg) => scope.postMessage(msg),
    (fn) => {
      scope.onmessage = (ev) => {
        if (ev.data?.type === "touch") fn();
      };
    },
  );
}
