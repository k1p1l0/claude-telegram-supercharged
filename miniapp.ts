/**
 * Telegram Mini App: a live board of the Claude Code sessions on this machine.
 *
 * server.ts calls startMiniApp() in the instance that owns the bot. The HTTP
 * server binds to 127.0.0.1 only; put it behind HTTPS (Tailscale Serve or
 * Funnel, Cloudflare Tunnel) and set TELEGRAM_MINIAPP_URL to that address.
 * With TELEGRAM_MINIAPP_URL=auto the bot runs a Cloudflare quick tunnel itself.
 * Every API call must carry Telegram initData signed for this bot by a user on
 * the allowlist, so the public URL shows nothing to anyone else.
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
  status: "busy" | "idle";
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
    agentsRunning: number;
    agents24h: number;
    toolCalls24h: number;
    tokens24h: Usage;
  };
  hourly: Array<Usage & { t: number; tools: number }>;
  sessions: SessionView[];
  activity: Activity[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ── Main thread: HTTP server, auth, /agents button ────────────────────

// TELEGRAM_MINIAPP_URL=auto: the address of the quick tunnel that startQuickTunnel() keeps running.
const tunnel: { url: string; state: "off" | "starting" | "up" | "missing" } = { url: "", state: "off" };

const isAuto = () => (process.env.TELEGRAM_MINIAPP_URL ?? "").trim() === "auto";

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

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

export function startMiniApp(opts: {
  token: string;
  isAllowed: (userId: string) => boolean;
  log: (msg: string) => void;
}): void {
  if (process.env.TELEGRAM_MINIAPP === "off") return;
  const port = Number(process.env.TELEGRAM_MINIAPP_PORT) || 8790;
  const htmlPath = join(import.meta.dir, "miniapp", "index.html");
  let worker: Worker | null = null;
  let snapshot: Snapshot | null = null;

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

  const fetch = (req: Request): Response => {
    const { pathname } = new URL(req.url);
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (pathname === "/" || pathname === "/index.html") {
      try {
        return new Response(readFileSync(htmlPath), { headers: HTML_HEADERS });
      } catch {
        return new Response("miniapp/index.html is missing next to server.ts", { status: 500 });
      }
    }
    if (pathname === "/api/state") {
      const m = /^tma (.+)$/.exec(req.headers.get("authorization") ?? "");
      const userId = m ? verifyInitData(m[1], opts.token) : null;
      if (!userId || !opts.isAllowed(userId)) return json({ error: "unauthorized" }, 401);
      touch();
      return json(snapshot ?? { loading: true });
    }
    return new Response("Not found", { status: 404 });
  };

  // After a restart or a lock takeover the old process can hold the port for a few seconds. A process
  // that dropped to MCP-only mode can hold it until it exits, so keep trying, less often after 30 s.
  const listen = (attempt: number) => {
    try {
      Bun.serve({ hostname: "127.0.0.1", port, fetch });
      opts.log(`mini app: listening on 127.0.0.1:${port}${miniAppUrl() ? `, public URL ${miniAppUrl()}` : ""}`);
      if (isAuto()) startQuickTunnel(port, opts.log);
    } catch (err) {
      if (attempt === 20) opts.log(`mini app: cannot listen on 127.0.0.1:${port}: ${err}. Trying again every 15 s.`);
      setTimeout(() => listen(attempt + 1), attempt < 20 ? 1500 : 15_000);
    }
  };
  listen(1);
}

// ── Worker thread: read sessions and transcripts, post snapshots ─────

const TICK_MS = 4000;
const ACTIVE_MS = 5 * 60_000;
const CHUNK = 8 << 20;
const MAX_ACTIVITY = 30;
const HIDDEN_TOOLS = new Set(["SubagentHandback"]);

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
  startedAt?: number;
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
      return "";
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

// Claude 5 models have a 1M window by default. Haiku and older models (claude-3-*, claude-opus-4-*)
// have 200K, unless the session already used more, which means it runs with the 1M option.
function contextWindow(model: string | null, used: number): number {
  const small = /haiku|^claude-(?:\d|[a-z]+-[1-4](?:-|$))/i.test(model ?? "");
  return small && used <= 200_000 ? 200_000 : 1_000_000;
}

function runWorker(post: (msg: unknown) => void, onTouch: (fn: () => void) => void): void {
  const home = userInfo().homedir || homedir();
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
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

  async function listSessions(): Promise<LiveSession[] | null> {
    try {
      const proc = Bun.spawn(["claude", "agents", "--json"], { stdout: "pipe", stderr: "ignore" });
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
    if (!isAssistant && !line.includes('"tool_result"')) return;
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
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (!c || typeof c !== "object") continue;
        f.lastKind = c.type;
        if (c.type !== "tool_use" || !c.id || f.pending.has(c.id)) continue;
        if (c.name === "SubagentHandback") f.handback = true;
        if (HIDDEN_TOOLS.has(c.name)) continue;
        const ref = { name: String(c.name), target: describe(c.name, c.input ?? {}), t };
        f.pending.set(c.id, ref);
        f.lastTool = ref;
        f.toolCalls++;
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
    } else if (e.type === "user" && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === "tool_result") f.pending.delete(c.tool_use_id);
    }
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
        status: s.status === "busy" ? "busy" : "idle",
        startedAt: s.startedAt ?? f?.firstTs ?? now,
        model: f?.model ?? null,
        contextTokens: f?.contextTokens ?? 0,
        contextWindow: contextWindow(f?.model ?? null, f?.contextTokens ?? 0),
        tokens: f?.tokens ?? zero(),
        toolCalls: f?.toolCalls ?? 0,
        currentTool: s.status === "busy" ? currentTool(f, now) : null,
        lastTool: f?.lastTool ?? null,
        lastActivity: lastActivity || s.startedAt || now,
        agents,
        agentsTotal: all.length,
      };
    });
    // Busy first in a stable order, so cards do not jump on every poll; idle ones by last activity.
    sessions.sort((a, b) =>
      a.status !== b.status
        ? Number(b.status === "busy") - Number(a.status === "busy")
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

    return {
      now,
      host,
      ready,
      totals: {
        sessions: sessions.length,
        busy: sessions.filter((s) => s.status === "busy").length,
        agentsRunning: sessions.reduce((n, s) => n + s.agents.filter((a) => a.status === "running").length, 0),
        agents24h,
        toolCalls24h,
        tokens24h,
      },
      hourly: series,
      sessions,
      activity,
    };
  }

  async function tick() {
    const now = Date.now();
    const idx = discover();
    let live = await listSessions();
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
