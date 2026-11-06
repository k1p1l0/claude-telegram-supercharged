// ask_user can post its question inside a forum topic. Pure helpers; server.ts wires them.

export const ASK_USER_THREAD_ENV = "TELEGRAM_ASK_USER_THREAD";

/** True only for the exact value `on` in the plugin's process environment, the way TELEGRAM_TOPIC_ROUTER is read. */
export function askUserThreadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ASK_USER_THREAD_ENV] === "on";
}

/**
 * The topic thread for an ask_user call. With the flag off (`enabled` false) thread_id is ignored whatever it holds, so
 * the call behaves as it did before. With it on, thread_id must be a positive whole number, and a topic that `isSilent`
 * reports is refused (same refusal as reply).
 */
export function askUserThreadId(
  raw: unknown,
  enabled: boolean,
  isSilent: (threadId: number) => boolean,
): number | undefined {
  if (!enabled || raw == null) return undefined;
  const numeric = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");
  const threadId = numeric ? Number(raw) : Number.NaN;
  if (!Number.isInteger(threadId) || threadId <= 0) {
    throw new Error(`thread_id must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  if (isSilent(threadId)) throw new Error("topic is silent: another machine owns it");
  return threadId;
}

/** The silent-topic test for askUserThreadId: it asks the topic map only while the topic router flag is also on. */
export function askUserSilentCheck(
  routerOn: boolean,
  inMap: (threadId: number) => boolean,
): (threadId: number) => boolean {
  return (threadId) => routerOn && inMap(threadId);
}

/** The sendMessage options for the question. message_thread_id is set only when a topic is given. */
export function askUserSendOptions<K>(
  threadId: number | undefined,
  parseMode: "MarkdownV2" | "HTML" | undefined,
  keyboard: K,
): { parse_mode?: "MarkdownV2" | "HTML"; message_thread_id?: number; reply_markup: K } {
  return {
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    reply_markup: keyboard,
  };
}

type PendingAsk = { resolve: (value: string) => void; timer: ReturnType<typeof setTimeout> };

/**
 * A tap on an `ask:<callbackId>:<label>` button. Resolves the pending question with the label and clears its timer.
 * An unknown id resolves nothing. Returns null when the data is not a well-formed ask tap.
 */
export function resolveAskCallback(
  pending: Map<string, PendingAsk>,
  data: string,
): { label: string; resolved: boolean } | null {
  if (!data.startsWith("ask:")) return null;
  const parts = data.split(":");
  if (parts.length < 3) return null;
  const callbackId = parts[1];
  const label = parts.slice(2).join(":"); // rejoin in case label contained ':'
  const entry = pending.get(callbackId);
  if (!entry) return { label, resolved: false };
  clearTimeout(entry.timer);
  pending.delete(callbackId);
  entry.resolve(label);
  return { label, resolved: true };
}
