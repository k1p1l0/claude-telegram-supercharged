// Owner stop controls (/stop, /stopall, /resume, /pause, /stops) and the /auto and /goal(s)
// commands forwarded to the
// agent-harness Telegram router. Pure and injectable: no grammy, no server state.
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type RouterButton = { label: string; text: string };
export type RouterResult =
  | { action: "bypass" }
  | { action: "drop" }
  | { action: "hold"; reply: string; project?: string; buttons?: RouterButton[] }
  | { action: string; [k: string]: unknown };
export type RouterInput = { chatId: string; userId: string; threadId?: string; text: string };
export type RouterModule = {
  routeTelegram: (input: RouterInput, options?: { accessFile?: string }) => RouterResult;
};

export type HookKeyboardButton = { text: string; callback_data: string };
export type HookOutput = { handled: false } | { handled: true; reply: string; keyboard?: HookKeyboardButton[] };

/** Plain-text view of what Telegram needs: one message and an optional inline keyboard. */
export type HookDeps = {
  /** Resolve the router module, or undefined when it is not installed. Injected for tests. */
  loadRouter: () => Promise<RouterModule | undefined>;
  /** True when this Telegram user id may use owner commands on this bot. */
  isOwner: (userId: string) => boolean;
  accessFile: string;
  /** Text sent to the router for /stops. The router names its status command; see docs. */
  statusText?: string;
};

export type HookInput = {
  text: string;
  chatType: string | undefined;
  chatId: string;
  userId: string;
  threadId?: string;
  /** Username of this bot, without @. */
  botUsername: string;
};

export const NOT_INSTALLED = "Stop controls are not installed.";
const CMD_RE = /^\/(stop|stopall|resume|pause|stops|auto|goal|goals)(?:@(\w+))?(?:\s+([\s\S]*))?$/i;
export const DEFAULT_ROUTER_PATH = "~/Projects/agent-harness/telegram-router.ts";

/** Resolve the router file path from env, expanding a leading ~. */
export function routerPath(env: Record<string, string | undefined> = process.env): string {
  const p = env.AGENT_HARNESS_ROUTER?.trim() || DEFAULT_ROUTER_PATH;
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Default loader: dynamic import; undefined when the file or its exports are missing. */
export function makeRouterLoader(path: string): () => Promise<RouterModule | undefined> {
  return async () => {
    try {
      const mod = (await import(pathToFileURL(path).href)) as Partial<RouterModule>;
      return typeof mod.routeTelegram === "function" ? (mod as RouterModule) : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Parse an owner command. Returns the text to hand to the router, or null if it is not one of ours. */
export function matchOwnerCommand(text: string, botUsername: string, statusText = "/stops"): string | null {
  const m = CMD_RE.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[3] ?? "").trim().replace(/\s+/g, " ");
  if (cmd === "stops") return arg ? null : statusText;
  return arg ? `/${cmd} ${arg}` : `/${cmd}`;
}

// callback_data tokens. The token only names a router command; the router validates it and the
// tapper is re-checked on every tap. All forms are far under Telegram's 64 byte limit.
//   stp:c|x:<id>:<generation>   /stopall confirm|cancel   (25 bytes at most)
//   aut:c|x:<generation>        /auto confirm|cancel      (15 bytes at most)
//   aut:u:<id>                  /auto undo <id>           (15 bytes at most)
//   aut:s                       /auto stop
//   gol:c|x:<generation>        /goal confirm|cancel      (15 bytes at most)
//   gol:s:<id>                  /goal stop <id>           (15 bytes at most)
const CONFIRM_RE = /^\/stopall (confirm|cancel) (\d{1,9}) (\d{1,9})$/;
const TOKEN_RE = /^stp:([cx]):(\d{1,9}):(\d{1,9})$/;
const AUTO_BTN_RE = /^\/auto (confirm|cancel|undo) (\d{1,9})$/;
const AUTO_STOP_RE = /^\/auto stop$/;
const GOAL_BTN_RE = /^\/goal (confirm|cancel|stop) (\d{1,9})$/;
const AUTO_TOKEN_RE = /^aut:(?:([cxu]):(\d{1,9})|(s))$/;
const GOAL_TOKEN_RE = /^gol:([cxs]):(\d{1,9})$/;
const AUTO_VERB: Record<string, string> = { c: "confirm", x: "cancel", u: "undo" };
const GOAL_VERB: Record<string, string> = { c: "confirm", x: "cancel", s: "stop" };
const AUTO_CODE: Record<string, string> = { confirm: "c", cancel: "x", undo: "u" };
const GOAL_CODE: Record<string, string> = { confirm: "c", cancel: "x", stop: "s" };

/** True for any callback_data this hook owns. */
export const isRouterCallbackData = (data: string): boolean => /^(?:stp|aut|gol):/.test(data);

export function encodeButton(commandText: string): string | null {
  let m = CONFIRM_RE.exec(commandText);
  if (m) return `stp:${m[1] === "confirm" ? "c" : "x"}:${m[2]}:${m[3]}`;
  if (AUTO_STOP_RE.test(commandText)) return "aut:s";
  m = AUTO_BTN_RE.exec(commandText);
  if (m) return `aut:${AUTO_CODE[m[1]]}:${m[2]}`;
  m = GOAL_BTN_RE.exec(commandText);
  if (m) return `gol:${GOAL_CODE[m[1]]}:${m[2]}`;
  return null;
}

export function decodeButton(data: string): string | null {
  if (new TextEncoder().encode(data).length > 64) return null;
  let m = TOKEN_RE.exec(data);
  if (m) return `/stopall ${m[1] === "c" ? "confirm" : "cancel"} ${m[2]} ${m[3]}`;
  m = AUTO_TOKEN_RE.exec(data);
  if (m) return m[3] ? "/auto stop" : `/auto ${AUTO_VERB[m[1]]} ${m[2]}`;
  m = GOAL_TOKEN_RE.exec(data);
  if (m) return `/goal ${GOAL_VERB[m[1]]} ${m[2]}`;
  return null;
}

async function run(deps: HookDeps, input: Omit<HookInput, "text">, routerText: string): Promise<HookOutput> {
  const router = await deps.loadRouter();
  if (!router) return { handled: true, reply: NOT_INSTALLED };
  let result: RouterResult;
  try {
    result = router.routeTelegram(
      { chatId: input.chatId, userId: input.userId, threadId: input.threadId, text: routerText },
      { accessFile: deps.accessFile },
    );
  } catch (err) {
    return {
      handled: true,
      reply: `Stop controls failed: ${String((err as Error)?.message ?? err).slice(0, 200)}. Nothing was changed.`,
    };
  }
  if (result.action === "bypass") return { handled: true, reply: NOT_INSTALLED };
  if (result.action === "drop") return { handled: true, reply: "Not authorized." };
  if (result.action !== "hold" || typeof (result as { reply?: unknown }).reply !== "string") {
    return { handled: true, reply: "Stop controls returned an unexpected result. Nothing was changed." };
  }
  const hold = result as Extract<RouterResult, { action: "hold" }>;
  let reply = hold.reply;
  const keyboard: HookKeyboardButton[] = [];
  for (const b of hold.buttons ?? []) {
    const data = encodeButton(b.text);
    if (data) keyboard.push({ text: b.label.slice(0, 40), callback_data: data });
    else reply += `\nSend: ${b.text}`; // a button we cannot encode must stay reachable
  }
  return { handled: true, reply, ...(keyboard.length ? { keyboard } : {}) };
}

/** A typed message. Not handled unless it is an owner command in a DM from an allowlisted user. */
export async function routeOwnerCommand(deps: HookDeps, input: HookInput): Promise<HookOutput> {
  if (input.chatType !== "private") return { handled: false };
  const routerText = matchOwnerCommand(input.text, input.botUsername, deps.statusText);
  if (routerText === null) return { handled: false };
  if (!deps.isOwner(input.userId)) return { handled: false };
  return run(deps, input, routerText);
}

/** A tapped `stp:`, `aut:` or `gol:` button. Always handled: the tapper is re-checked, never trusted from the token. */
export async function routeOwnerCallback(
  deps: HookDeps,
  input: Omit<HookInput, "text"> & { data: string },
): Promise<HookOutput> {
  const routerText = decodeButton(input.data);
  if (routerText === null) return { handled: true, reply: "This button is no longer valid." };
  if (input.chatType !== "private" || input.chatId !== input.userId || !deps.isOwner(input.userId)) {
    return { handled: true, reply: "Not authorized." };
  }
  return run(deps, input, routerText);
}

// --- grammy glue, structural so this file needs no import of grammy ---
type CtxLike = {
  chat?: { id: number | string; type: string };
  from?: { id: number | string };
  me: { username: string };
  message?: { text?: string; message_thread_id?: number };
  callbackQuery?: { data?: string; message?: { chat: { id: number | string; type: string }; message_id: number } };
  reply: (text: string, ...rest: any[]) => Promise<unknown>;
  answerCallbackQuery: (...rest: any[]) => Promise<unknown>;
  editMessageText: (text: string, ...rest: any[]) => Promise<unknown>;
};

const markup = (kb: HookKeyboardButton[]) => ({ reply_markup: { inline_keyboard: [kb] } });

export async function handleRouterMessage(ctx: CtxLike, deps: HookDeps): Promise<boolean> {
  const out = await routeOwnerCommand(deps, {
    text: ctx.message?.text ?? "",
    chatType: ctx.chat?.type,
    chatId: String(ctx.chat?.id ?? ""),
    userId: String(ctx.from?.id ?? ""),
    threadId: ctx.message?.message_thread_id === undefined ? undefined : String(ctx.message.message_thread_id),
    botUsername: ctx.me.username,
  });
  if (!out.handled) return false;
  await ctx.reply(out.reply, out.keyboard ? markup(out.keyboard) : undefined);
  return true;
}

export async function handleRouterCallback(ctx: CtxLike, deps: HookDeps): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  const out = await routeOwnerCallback(deps, {
    data: ctx.callbackQuery?.data ?? "",
    chatType: msg?.chat.type,
    chatId: String(msg?.chat.id ?? ""),
    userId: String(ctx.from?.id ?? ""),
    botUsername: ctx.me.username,
  });
  if (!out.handled) return;
  await ctx.answerCallbackQuery({ text: out.reply.slice(0, 200) }).catch(() => {});
  // Edit without a keyboard so a second tap cannot repeat the action.
  if (msg) await ctx.editMessageText(out.reply.slice(0, 4000)).catch(() => {});
}
