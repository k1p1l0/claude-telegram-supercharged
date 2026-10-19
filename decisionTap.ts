// Pure helpers for `dec:<CODE>:<key>` inline-keyboard taps (decision messages).
// No dependencies, so they can be unit-tested without the bot.

const DEC_RE = /^dec:([A-Za-z0-9][A-Za-z0-9_.-]*):([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/** Parse callback_data `dec:<CODE>:<key>`. Returns null for anything else, including `dec:done`. */
export function parseDecisionData(data: string): { code: string; key: string } | null {
  if (typeof data !== "string") return null;
  if (new TextEncoder().encode(data).length > 64) return null;
  if (data === "dec:done") return null;
  const m = DEC_RE.exec(data);
  if (!m) return null;
  return { code: m[1], key: m[2] };
}

/** A button label as the tap stores it: whitespace collapsed, trimmed, at most 200 characters. Null when empty. */
export function cleanLabel(text: string): string | null {
  const label = String(text).replace(/\s+/g, " ").trim().slice(0, 200);
  return label.length ? label : null;
}

/** Find the button whose callback_data equals `data` in an inline_keyboard (array of rows) and return its label. */
export function labelFromKeyboard(keyboard: unknown, data: string): string | null {
  if (!Array.isArray(keyboard)) return null;
  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (btn && typeof btn === "object" && (btn as any).callback_data === data) {
        const text = (btn as any).text;
        if (typeof text !== "string") return null;
        return cleanLabel(text);
      }
    }
  }
  return null;
}

/** The text stored for a tap, in the same shape as a typed answer: "<CODE> <label>". */
export function tapRowText(code: string, label: string): string {
  return `${code} ${label}`;
}

/**
 * Telegram gives a button tap no message id of its own. The messages table is
 * UNIQUE(chat_id, message_id, bot) with INSERT OR REPLACE, so reusing the
 * decision message's id would overwrite that row. We use a negative id, which
 * never collides with a real (positive) Telegram message id. It is derived from
 * the numeric digits of the callback query id (32-bit FNV-1a) combined with
 * nowMs, so two taps get different ids.
 */
export function syntheticTapId(callbackQueryId: string, nowMs: number): number {
  const digits = String(callbackQueryId).replace(/\D/g, "") || String(callbackQueryId);
  let h = 0x811c9dc5;
  for (let i = 0; i < digits.length; i++) {
    h ^= digits.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // h < 2^32; nowMs < 2^41 => h * 2^20 + (nowMs mod 2^20) < 2^52, a safe integer.
  const n = h * 1048576 + (Math.floor(Math.abs(nowMs)) % 1048576);
  return -(n + 1);
}

/** The reserved option key every decision card carries as its last button. */
export const LATER_KEY = "later";

/** The label of the inert button that replaces the keyboard once a decision is answered. */
export function doneButtonText(label: string): string {
  return `✅ ${label}`;
}

/** The part of the message store a tap needs. MessageStore in server.ts satisfies it. */
export interface TapStore {
  store(msg: {
    message_id: number;
    chat_id: string;
    user_id?: string;
    username?: string;
    first_name?: string;
    text?: string;
    reply_to_msg_id?: number;
    date: number;
    is_outgoing?: boolean;
    bot?: string;
  }): void;
}

export interface TapInput {
  /** Id that makes the synthetic message id unique: the Telegram callback query id, or a Mini App request id. */
  tapId: string;
  nowMs: number;
  chatId: string;
  userId?: string;
  username?: string;
  firstName?: string;
  code: string;
  key: string;
  label: string;
  /** The decision message that carried the buttons. */
  decisionMsgId: number;
  /** History key of the bot that sent it ("" for the primary bot). */
  bot: string;
}

/**
 * Records one decision tap as a messages row: text "<CODE> <label>", a negative synthetic id and
 * reply_to_msg_id = the decision message. Both the Telegram button and the Mini App go through here,
 * so the row is the same. Throws when the store fails.
 */
export function recordDecisionTap(store: TapStore, t: TapInput): { messageId: number; text: string; later: boolean } {
  const messageId = syntheticTapId(t.tapId, t.nowMs);
  const text = tapRowText(t.code, t.label);
  store.store({
    message_id: messageId,
    chat_id: t.chatId,
    user_id: t.userId,
    username: t.username,
    first_name: t.firstName,
    text,
    reply_to_msg_id: t.decisionMsgId,
    date: Math.floor(t.nowMs / 1000),
    is_outgoing: false,
    bot: t.bot,
  });
  return { messageId, text, later: t.key === LATER_KEY };
}
