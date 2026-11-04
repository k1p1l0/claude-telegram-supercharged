// The topic router for a forum supergroup: which topic the bot listens to, which it leaves to another machine, and
// which thread an answer goes to. Pure functions and one file reader, so a test can pin every case.
//
//   flag      TELEGRAM_TOPIC_ROUTER, exactly `on`, in the plugin's process environment. Off, nothing below runs and
//             server.ts behaves as before: no lookup and no thread default.
//   map       DATA_DIR/topic-map.json, checked with a stat on every call (the access.json pattern: a change needs no
//             restart). { "<chat_id>": { "<thread_id>": { "name": "Ops", "owner": "daemon", "requireMention": false } } }
//             owner: `daemon` (this bot answers in the topic) or `silent` (another machine owns the topic: this bot
//             drops the message, no ack and no reply). Any other name is treated like `daemon`. requireMention
//             overrides the group's own value for that topic.
//   unknown   a topic (or a chat) the map does not list gets the group's own rule and the owner `daemon`.
//   outbound  a reply inside a topic carries the thread id of the message it answers.
//   bubble    the Working bubble appears in a mapped, non-silent topic and carries its thread id (progressRender.ts).

import { lstatSync, readFileSync } from "node:fs";

export const TOPIC_ROUTER_ENV = "TELEGRAM_TOPIC_ROUTER";
export const TOPIC_MAP_FILE = "topic-map.json";
export const TOPIC_MAP_MAX_BYTES = 64 * 1024;
export const TOPIC_OWNER_DAEMON = "daemon";
export const TOPIC_OWNER_SILENT = "silent";
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const TOPIC_NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const TOPIC_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/;
const TOPIC_CHAT_RE = /^-[0-9]{1,20}$/;
const TOPIC_THREAD_RE = /^[1-9][0-9]{0,11}$/;

export interface TopicEntry {
  name: string;
  owner: string;
  requireMention?: boolean;
}
export type TopicMap = Record<string, Record<string, TopicEntry>>;

/** True only for the exact value `on`. */
export function topicRouterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[TOPIC_ROUTER_ENV] === "on";
}

/** An entry that fails the shape is left out, so one bad line never changes a topic's owner by accident. */
export function parseTopicMap(raw: string): TopicMap {
  const out: TopicMap = {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [chat, topics] of Object.entries(v as Record<string, unknown>)) {
    if (!TOPIC_CHAT_RE.test(chat) || !topics || typeof topics !== "object" || Array.isArray(topics)) continue;
    const byThread: Record<string, TopicEntry> = {};
    for (const [thread, e] of Object.entries(topics as Record<string, unknown>)) {
      if (!TOPIC_THREAD_RE.test(thread) || !e || typeof e !== "object" || Array.isArray(e)) continue;
      const { name, owner, requireMention } = e as Record<string, unknown>;
      if (typeof name !== "string" || !TOPIC_NAME_RE.test(name)) continue;
      if (typeof owner !== "string" || !TOPIC_OWNER_RE.test(owner)) continue;
      if (requireMention !== undefined && typeof requireMention !== "boolean") continue;
      byThread[thread] = { name, owner, ...(requireMention !== undefined ? { requireMention } : {}) };
    }
    if (Object.keys(byThread).length > 0) out[chat] = byThread;
  }
  return out;
}

/**
 * A reader of the map file for one path. It stats the file on every call and parses again only when the size or the
 * time changed. A missing, oversized or unreadable file is an empty map (every topic then follows its group's rule).
 */
export function makeTopicMapReader(path: string): () => TopicMap {
  let key = "";
  let cached: TopicMap = {};
  return () => {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size > TOPIC_MAP_MAX_BYTES) {
        key = "";
        cached = {};
        return cached;
      }
      const k = `${st.size}:${st.mtimeMs}`;
      if (k !== key) {
        cached = parseTopicMap(readFileSync(path, "utf8"));
        key = k;
      }
      return cached;
    } catch {
      key = "";
      cached = {};
      return cached;
    }
  };
}

export type TopicRoute =
  | { kind: "drop" }
  | { kind: "deliver"; owner: string; name: string | null; requireMention: boolean; mapped: boolean };

/**
 * Where a group message goes. `silent` drops it. A mapped topic may override requireMention. A message with no thread
 * id (the group's General topic), an unmapped topic and an unmapped chat follow the group rule with owner `daemon`.
 */
export function topicRoute(
  map: TopicMap,
  chatId: string,
  threadId: number | string | null | undefined,
  groupRequireMention: boolean,
): TopicRoute {
  const e = threadId != null ? map[chatId]?.[String(threadId)] : undefined;
  if (!e)
    return {
      kind: "deliver",
      owner: TOPIC_OWNER_DAEMON,
      name: null,
      requireMention: groupRequireMention,
      mapped: false,
    };
  if (e.owner === TOPIC_OWNER_SILENT) return { kind: "drop" };
  return {
    kind: "deliver",
    owner: e.owner,
    name: e.name,
    requireMention: e.requireMention ?? groupRequireMention,
    mapped: true,
  };
}

/**
 * The pre-gate buffer key. With the router on, a buffered line waits for a mention in its own topic only: topics have
 * their own requireMention, so a line in a no-mention topic must not promote an unmentioned line of a mention topic.
 * Off: the chat's key, as before.
 */
export function pregateKeyOf(chatKey: string, threadId: number | string | null | undefined, routerOn: boolean): string {
  return routerOn && threadId != null ? `${chatKey}#t${threadId}` : chatKey;
}

/** True when the map says this topic is `silent`: another machine owns it and this bot must post nothing there. */
export function topicIsSilent(map: TopicMap, chatId: string, threadId: number | string | null | undefined): boolean {
  return topicRoute(map, chatId, threadId, true).kind === "drop";
}

/**
 * The thread an outbound reply goes to. An explicit thread id wins. Without one, the thread comes from the message
 * being replied to (known from the inbound store), so a reply inside a topic never lands in General.
 */
export function outboundThread(
  explicit: number | undefined,
  replyTo: number | undefined,
  threadOf: (msgId: number) => number | undefined,
): number | undefined {
  if (explicit != null) return explicit;
  return replyTo != null ? threadOf(replyTo) : undefined;
}
