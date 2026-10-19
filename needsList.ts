// "Needs you": one list of what waits for Kyrylo, read for the Mini App (GET /api/needs) and answered from it
// (POST /api/needs/answer). Decisions come from the telegram-decisions skill's state.json, read under the shared
// side of its lock. Task approvals come from tasks.db, opened read-only. Inbox NEEDS YOU blocks are not wired.
// No dependencies on the bot: server.ts passes the message store and the card editor in.

import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LATER_KEY, type TapStore, cleanLabel, doneButtonText, recordDecisionTap, tapRowText } from "./decisionTap";

export type SourceStatus = "ok" | "error" | "not wired";
export interface Source<T> {
  status: SourceStatus;
  items: T[];
  error?: string;
}

export interface NeedsOption {
  key: string;
  label: string;
}

export interface NeedsDecision {
  source: "decision";
  project: string;
  code: string;
  title: string;
  text: string;
  options: NeedsOption[];
  version: number;
  queued_at: string | null;
  sent_at: string | null;
  age_s: number | null;
  live: boolean;
  /** False for old reply-keyboard decisions and decisions whose card is not sent yet: answer those in Telegram. */
  answerable: boolean;
  reason?: string;
}

export interface NeedsApproval {
  source: "approval";
  id: number;
  task_id: number;
  title: string;
  text: string;
  requested_by: string;
  requested_at: string;
  age_s: number | null;
}

export interface NeedsResponse {
  now: number;
  decisions: Source<NeedsDecision>;
  approvals: Source<NeedsApproval>;
  inbox: Source<never>;
}

// ── redaction and clipping ──

const SECRET_RES = [
  /\d{5,}:[A-Za-z0-9_-]{20,}/g, // Telegram bot token
  /\bsk-[A-Za-z0-9_-]{16,}/g, // API keys
  /\b(?:ghp|gho|ghs|github_pat|xox[abprs])[-_A-Za-z0-9]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Nothing shaped like a token leaves the server in a list item. */
export function redact(s: string): string {
  let out = String(s ?? "");
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return out;
}

export function clipText(s: string, n: number): string {
  const t = redact(s).replace(/\r/g, "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

const firstLine = (s: string) =>
  redact(s)
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

// ── state.json under the shared lock ──

const LOCK_HELPER =
  "import fcntl,sys\n" +
  "try:\n fh=open(sys.argv[1],'r')\nexcept FileNotFoundError:\n fh=None\n" +
  "if fh:\n fcntl.flock(fh,fcntl.LOCK_SH)\n" +
  "try:\n data=open(sys.argv[2],'rb').read()\nexcept FileNotFoundError:\n data=b''\n" +
  "sys.stdout.buffer.write(data)\n";

/**
 * Reads state.json while holding LOCK_SH on the skill's .state.lock. The skill's writer takes LOCK_EX through
 * fcntl.flock, so a read never sees a half-written file and waits while it writes. bun has no flock, so a small
 * child does it: flock(1) when it exists, else python3 -I. The child is killed after timeoutMs, so a stuck
 * writer shows as an error instead of hanging the board. Returns null when the file does not exist.
 */
export function lockedRead(
  statePath: string,
  lockPath: string,
  timeoutMs = 4000,
  run: typeof execFile = execFile,
): Promise<string | null> {
  const flock = Bun.which("flock");
  const [cmd, args] =
    flock && existsSync(lockPath) && existsSync(statePath)
      ? [flock, ["-s", "-w", String(Math.max(1, Math.floor(timeoutMs / 1000) - 1)), lockPath, "cat", statePath]]
      : ["python3", ["-I", "-c", LOCK_HELPER, lockPath, statePath]];
  return new Promise((resolve, reject) => {
    run(cmd, args, { timeout: timeoutMs, maxBuffer: 16 << 20, encoding: "utf8" }, (err, stdout) => {
      if (err)
        return reject(
          new Error(`state.json read failed: ${(err as any).killed ? "timed out on the lock" : err.message}`),
        );
      resolve(stdout === "" ? null : stdout);
    });
  });
}

interface RawDecision {
  project?: string;
  code?: string;
  options?: Record<string, string>;
  text?: string;
  version?: number;
  shown?: number;
  msg?: number | null;
  queued_at?: string;
  sent_at?: string | null;
  kind?: string;
  answered?: null | { option?: string | null; label?: string | null; at?: string; version?: number };
}
interface RawState {
  live: string | null;
  queue: string[];
  decisions: Record<string, RawDecision>;
}

export function parseState(raw: string | null): RawState {
  if (raw === null) return { live: null, queue: [], decisions: {} };
  const st = JSON.parse(raw);
  if (!st || typeof st !== "object" || typeof st.decisions !== "object" || !st.decisions)
    throw new Error("state.json has no decisions object");
  return { live: st.live ?? null, queue: Array.isArray(st.queue) ? st.queue : [], decisions: st.decisions };
}

const isOpen = (d: RawDecision | undefined): d is RawDecision => !!d && !d.answered;
const secondsSince = (iso: string | undefined | null, nowMs: number): number | null => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null;
};

/**
 * Why a tap on this decision would not count. Ported from tg_decisions.py: tap_answer() accepts a tap only on an
 * inline decision that is not answered and whose message id is the card (reply_to_msg_id == d["msg"]), and
 * verdict() refuses an answer when d["shown"] != d["version"] (the card is not the newest text). Old
 * reply-keyboard decisions are read from typed text only, and classify() ignores a negative-id row for them.
 * Returns null when a tap counts.
 */
export function notAnswerable(d: RawDecision): string | null {
  if (d.answered) return "closed";
  if (d.kind !== "inline") return "This is an old reply-keyboard decision. Answer it in Telegram.";
  if (!d.msg) return "The card is not sent yet.";
  if (Number(d.shown) !== Number(d.version))
    return "The card shows an older version. Answer the newest card in Telegram.";
  return null;
}

/** Open decisions in the order `queue` prints them: the live one, the old queue, then inline ones oldest first. */
export function buildDecisions(st: RawState, nowMs: number): NeedsDecision[] {
  const seen = new Set<string>();
  const inline = Object.keys(st.decisions)
    .filter((k) => isOpen(st.decisions[k]) && st.decisions[k].kind === "inline")
    .sort((a, b) => String(st.decisions[a].queued_at ?? "").localeCompare(String(st.decisions[b].queued_at ?? "")));
  const keys = [...(st.live ? [st.live] : []), ...st.queue, ...inline].filter((k) => {
    if (seen.has(k) || !isOpen(st.decisions[k])) return false;
    seen.add(k);
    return true;
  });
  return keys.map((k): NeedsDecision => {
    const d = st.decisions[k];
    const why = notAnswerable(d);
    const text = String(d.text ?? "");
    return {
      source: "decision",
      project: String(d.project ?? k.split("/")[0]),
      code: String(d.code ?? k.split("/").slice(1).join("/")),
      title: clipText(firstLine(text), 140),
      text: clipText(text, 1500),
      options: Object.entries(d.options ?? {}).map(([key, label]) => ({
        key,
        label: cleanLabel(String(label)) ?? key,
      })),
      version: Number(d.version) || 0,
      queued_at: d.queued_at ?? null,
      sent_at: d.sent_at ?? null,
      age_s: secondsSince(d.queued_at, nowMs),
      live: st.live === k,
      answerable: why === null,
      ...(why ? { reason: why } : {}),
    };
  });
}

// ── approvals: tasks.db, read-only ──

export function defaultTasksDb(): string {
  return process.env.TELEGRAM_MINIAPP_TASKS_DB || join(homedir(), "agent-inbox", "tasks.db");
}

export function readApprovalsDb(dbPath: string, nowMs: number): Source<NeedsApproval> {
  if (!existsSync(dbPath)) return { status: "not wired", items: [], error: "tasks.db not found on this machine" };
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const rows = db
      .query(
        `SELECT a.id AS id, a.task_id AS task_id, COALESCE(t.title, '') AS title, a.action AS action,
                a.requested_by AS requested_by, a.requested_at AS requested_at
         FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id
         WHERE a.status = 'pending' ORDER BY a.id`,
      )
      .all() as Array<Record<string, any>>;
    return {
      status: "ok",
      items: rows.map((r) => ({
        source: "approval" as const,
        id: Number(r.id),
        task_id: Number(r.task_id),
        title: clipText(String(r.title), 140),
        text: clipText(String(r.action), 600),
        requested_by: String(r.requested_by),
        requested_at: String(r.requested_at),
        age_s: secondsSince(String(r.requested_at), nowMs),
      })),
    };
  } catch (err) {
    return { status: "error", items: [], error: `tasks.db: ${(err as Error).message}`.slice(0, 200) };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

// ── the list and the answer ──

export interface NeedsStore extends TapStore {
  /** Texts of the negative-id rows (button taps) that point at one decision message. */
  taps(chatId: string, replyTo: number, bot: string): string[];
}

export interface NeedsDeps {
  readState: () => Promise<string | null>;
  readApprovals: (nowMs: number) => Source<NeedsApproval>;
  store: NeedsStore;
  /** Replaces the card's keyboard with the inert done button. */
  editCard: (chatId: string, messageId: number, buttonText: string) => Promise<void>;
  /** History key of the primary bot, as botKey() gives it. */
  bot: string;
  /**
   * The chat the decision cards live in (the owner's private chat). Only that user can answer from the Mini App:
   * the tap row and the card edit go to this chat, so an answer from anyone else would be written to a chat that
   * does not hold the card. Undefined (tests only) means the requester's own chat.
   */
  cardChat?: () => string | null;
  now?: () => number;
  log?: (msg: string) => void;
  /** Where the "needs list codes=…" lines are appended with a timestamp, next to state.json. Off when unset. */
  answersLog?: string;
}

export type Reply = [number, Record<string, unknown>];
export const CACHE_MS = 2000;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function createNeeds(deps: NeedsDeps) {
  const now = deps.now ?? Date.now;
  let cache: { at: number; value: Promise<NeedsResponse> } | null = null;
  const chain = new Map<string, Promise<unknown>>();
  let counter = 0;
  let lastCodes: string | null = null;
  let appendFailed = false;

  /**
   * One line when the set of open decision codes in the answer changes (also the first answer): to the plugin log and,
   * with a timestamp, to needs-answers.log next to the state file, so a later report has server evidence of what the
   * Mini App was told and when. Only the codes, never the text.
   */
  function noteCodes(items: NeedsDecision[]): void {
    const codes = items
      .map((d) => d.code)
      .sort()
      .join(",");
    if (codes === lastCodes) return;
    lastCodes = codes;
    const line = `mini app: needs list codes=${codes}`;
    deps.log?.(line);
    if (!deps.answersLog) return;
    try {
      appendFileSync(deps.answersLog, `${new Date(now()).toISOString()} ${line}\n`);
    } catch (err) {
      if (!appendFailed) deps.log?.(`needs: could not append to ${deps.answersLog}: ${err}`);
      appendFailed = true;
    }
  }

  async function build(): Promise<NeedsResponse> {
    const nowMs = now();
    let decisions: Source<NeedsDecision>;
    try {
      decisions = { status: "ok", items: buildDecisions(parseState(await deps.readState()), nowMs) };
      noteCodes(decisions.items);
    } catch (err) {
      decisions = { status: "error", items: [], error: String((err as Error).message ?? err).slice(0, 200) };
    }
    let approvals: Source<NeedsApproval>;
    try {
      approvals = deps.readApprovals(nowMs);
    } catch (err) {
      approvals = { status: "error", items: [], error: String((err as Error).message ?? err).slice(0, 200) };
    }
    return {
      now: nowMs,
      decisions,
      approvals,
      inbox: { status: "not wired", items: [], error: "Inbox NEEDS YOU blocks are not read yet" },
    };
  }

  function list(): Promise<NeedsResponse> {
    const t = now();
    if (cache && t - cache.at < CACHE_MS && t >= cache.at) return cache.value;
    const value = build();
    cache = { at: t, value };
    return value;
  }

  async function answerNow(userId: string, body: Record<string, unknown>): Promise<Reply> {
    const code = typeof body.code === "string" ? body.code : "";
    const option = typeof body.option === "string" ? body.option : "";
    const project = typeof body.project === "string" ? body.project : "";
    const version = Number(body.version);
    if (!NAME_RE.test(code)) return [400, { error: "code is missing or malformed", reason: "bad_request" }];
    if (!NAME_RE.test(option)) return [400, { error: "option is missing or malformed", reason: "bad_request" }];
    if (!Number.isInteger(version) || version < 1)
      return [400, { error: "version must be a positive integer", reason: "bad_request" }];

    let st: RawState;
    try {
      st = parseState(await deps.readState());
    } catch (err) {
      return [
        503,
        { error: `Could not read the decisions: ${(err as Error).message}`.slice(0, 200), reason: "state_unreadable" },
      ];
    }
    const matches = Object.entries(st.decisions).filter(
      ([k, d]) => d.code === code && (!project || (d.project ?? k.split("/")[0]) === project),
    );
    if (!matches.length) return [404, { error: "No such decision.", reason: "not_found" }];
    const open = matches.filter(([, d]) => isOpen(d));
    if (open.length > 1)
      return [400, { error: "Several open decisions share this code. Send the project too.", reason: "ambiguous" }];
    const answeredReply = (d: RawDecision): Reply | null => {
      const a = d.answered;
      if (a?.option && a.version === version && d.options?.[a.option] !== undefined)
        return [
          200,
          {
            ok: true,
            already: true,
            answer: { code, version, option: a.option, label: cleanLabel(d.options[a.option]) ?? a.option },
          },
        ];
      return null;
    };
    if (!open.length) {
      const newest = matches
        .map(([, d]) => d)
        .sort((a, b) => String(b.answered?.at ?? "").localeCompare(String(a.answered?.at ?? "")))[0];
      return answeredReply(newest) ?? [409, { error: "This decision is already closed.", reason: "closed" }];
    }
    const d = open[0][1];
    if (Number(d.version) !== version)
      return [
        409,
        { error: "This decision changed. Reload the list.", reason: "stale", version: Number(d.version) || 0 },
      ];
    if (d.options?.[option] === undefined)
      return [400, { error: "Unknown option for this decision.", reason: "unknown_option" }];
    const why = notAnswerable(d);
    if (why) return [409, { error: why, reason: "not_answerable" }];
    const label = cleanLabel(String(d.options[option]));
    if (!label) return [409, { error: "That option has no label.", reason: "not_answerable" }];

    const chatId = deps.cardChat ? deps.cardChat() : userId;
    if (!chatId || chatId !== userId)
      return [
        403,
        {
          error: "Only the owner of the decision chat can answer here. Use the card in Telegram.",
          reason: "not_owner",
        },
      ];
    const decisionMsg = Number(d.msg);
    // A tap row for this card is the first answer. It lives in messages.db, so a restart cannot lose it.
    let prior: string[] = [];
    try {
      prior = deps.store.taps(chatId, decisionMsg, deps.bot);
    } catch (err) {
      deps.log?.(`needs: tap lookup failed: ${err}`);
    }
    for (const [k, l] of Object.entries(d.options)) {
      const lab = cleanLabel(String(l));
      if (k !== LATER_KEY && lab && prior.includes(tapRowText(code, lab)))
        return [200, { ok: true, already: true, answer: { code, version, option: k, label: lab } }];
    }

    const t = now();
    try {
      recordDecisionTap(deps.store, {
        tapId: `${decisionMsg}${version}${t}${++counter}`,
        nowMs: t,
        chatId,
        userId,
        code,
        key: option,
        label,
        decisionMsgId: decisionMsg,
        bot: deps.bot,
      });
    } catch (err) {
      deps.log?.(`needs: tap store failed: ${err}`);
      return [500, { error: "Could not record the answer.", reason: "store_failed" }];
    }
    cache = null;
    if (option === LATER_KEY)
      return [200, { ok: true, already: false, later: true, answer: { code, version, option, label } }];
    let cardUpdated = true;
    try {
      await deps.editCard(chatId, decisionMsg, doneButtonText(label));
    } catch {
      cardUpdated = false; // the answer is recorded; the Telegram card keeps its buttons until the next edit
    }
    return [200, { ok: true, already: false, card_updated: cardUpdated, answer: { code, version, option, label } }];
  }

  /** One answer at a time per decision, so two quick taps cannot both pass the check. */
  function answer(userId: string, body: Record<string, unknown>): Promise<Reply> {
    const id = typeof body.code === "string" ? body.code : "";
    const run = (chain.get(id) ?? Promise.resolve()).catch(() => {}).then(() => answerNow(userId, body));
    chain.set(id, run);
    run
      .finally(() => {
        if (chain.get(id) === run) chain.delete(id);
      })
      .catch(() => {});
    return run;
  }

  return { list, answer };
}
