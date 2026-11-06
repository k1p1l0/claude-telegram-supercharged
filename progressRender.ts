// DUR-615: the Working bubble, as pure functions of the turn and the clock so a test can pin every output.
// Spin on: "<animated Claude asterisk> **Verb…** (1m 12s)" with a verb that rotates every 6 s.
// Spin off (TELEGRAM_PROGRESS_SPIN=off): the old plain "Working... (12s)" with no entities.
// Bots may send custom emoji to private chats and groups when the bot's owner has Telegram Premium. If Telegram
// rejects the entity once, the bubble falls back to the plain emoji for the rest of the run (BubbleStyle.custom).

export type ProgressPhase = "tool" | "thinking" | "writing" | "idle";

export type ProgressView = {
  startedAt: number;
  lines: string[];
  hidden: number;
  phase: ProgressPhase;
};

// The subset of Telegram's MessageEntity the bubble uses.
export type BubbleEntity =
  | { type: "bold"; offset: number; length: number }
  | { type: "custom_emoji"; offset: number; length: number; custom_emoji_id: string };

export const PROGRESS_EMOJI = "💬"; // the base character the custom emoji sits on
export const PROGRESS_EMOJI_ID = "5368808376694248152"; // animated Claude asterisk, t.me/addemoji/AIByVolodya
export const PROGRESS_VERB_MS = 6000;
export const PROGRESS_VERBS = [
  "Thinking",
  "Pondering",
  "Deciphering",
  "Brewing",
  "Cooking",
  "Crafting",
  "Conjuring",
  "Mulling",
  "Noodling",
  "Percolating",
  "Ruminating",
  "Scheming",
  "Tinkering",
  "Untangling",
  "Wrangling",
  "Synthesizing",
  "Musing",
  "Computing",
  "Forging",
  "Spelunking",
  "Marinating",
  "Simmering",
  "Puzzling",
  "Hatching",
  "Whirring",
  "Churning",
  "Sleuthing",
  "Distilling",
  "Weaving",
  "Finagling",
];

const PHASE_LINES: Partial<Record<ProgressPhase, string>> = {
  thinking: "💭 Thinking…",
  writing: "✍️ Writing…",
};

export function hasPhaseLine(phase: ProgressPhase): boolean {
  return PHASE_LINES[phase] !== undefined;
}

// TELEGRAM_PROGRESS_SPIN=off turns the animation off; anything else leaves it on.
export function spinEnabled(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "off";
}

export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function progressVerb(startedAt: number, now: number): string {
  const step = Math.floor(Math.max(0, now - startedAt) / PROGRESS_VERB_MS);
  return PROGRESS_VERBS[(Math.floor(startedAt / 1000) + step) % PROGRESS_VERBS.length];
}

export type BubbleStyle = { custom: boolean };

export function isEntityError(err: unknown): boolean {
  return /entit|emoji/i.test(String((err as { description?: string })?.description ?? err));
}

// After a failed send or edit: true when the error is an entity refusal and the style was still on custom, so the
// caller marks the turn dirty and the next tick sends the plain emoji. The flag only ever goes from true to false.
export function fallBackOnEntityError(style: BubbleStyle, err: unknown): boolean {
  if (!style.custom || !isEntityError(err)) return false;
  style.custom = false;
  return true;
}

export type BubbleView = { text: string; entities?: BubbleEntity[] };

export function renderBubble(t: ProgressView, now: number, spin: boolean, style: BubbleStyle): BubbleView {
  const elapsed = now - t.startedAt;
  const more = t.hidden > 0 ? [`… ${t.hidden} earlier`] : [];
  const status = PHASE_LINES[t.phase];
  const tail = [...more, ...t.lines, ...(status ? [status] : [])];
  if (!spin) return { text: [`Working... (${Math.round(elapsed / 1000)}s)`, ...tail].join("\n") };
  const head = `${PROGRESS_EMOJI} `;
  const verbText = `${progressVerb(t.startedAt, now)}…`;
  const text = [`${head}${verbText} (${formatElapsed(elapsed)})`, ...tail].join("\n");
  const entities: BubbleEntity[] = [{ type: "bold", offset: head.length, length: verbText.length }];
  if (style.custom)
    entities.unshift({
      type: "custom_emoji",
      offset: 0,
      length: PROGRESS_EMOJI.length,
      custom_emoji_id: PROGRESS_EMOJI_ID,
    });
  return { text, entities };
}

// The answer takes over the bubble: the reply text replaces the whole bubble text. The bubble's entities are never
// carried over (Telegram would otherwise apply the bold and custom-emoji offsets to the reply, and it ignores
// parse_mode whenever entities are present), so the options hold the reply's own parse mode and extras only.
export function takeoverEditOptions<P extends string, E extends object>(
  parseMode: P | undefined,
  extra: E,
): { parse_mode?: P } & E {
  return { ...(parseMode ? { parse_mode: parseMode } : {}), ...extra };
}

// What a turn's progress state becomes once the answer has taken the bubble: no lines, no phase, nothing dirty.
export function detachedProgress(now: number) {
  return {
    lines: [] as string[],
    hidden: 0,
    dirty: false,
    phase: "idle" as ProgressPhase,
    lastSentAt: now,
    lastTyping: now,
  };
}

// DUR-615 (F5): the bubble flush runs under trackFlush, which keeps its promise in t.inflight. takeBubbleCapped waits for
// that promise however long Telegram takes, so a slow progress edit can never land after the answer's edit, and a
// first send that is still in flight has set t.msgId before the answer takes it.
export type FlushTurn = { sending: boolean; inflight?: Promise<void>; gen?: number };

export function trackFlush(t: FlushTurn, run: () => Promise<void>): Promise<void> {
  t.sending = true;
  const p: Promise<void> = run().finally(() => {
    t.sending = false;
    if (t.inflight === p) t.inflight = undefined;
  });
  t.inflight = p;
  return p;
}

// DUR-617 (rv-790 F9): the wait for an in-flight progress edit is capped, so a stuck Telegram call cannot hold the
// answer back for good. Overridable per call (tests pass a few ms).
export const TAKEOVER_WAIT_MS = 10_000;

export type TakenBubble = { id: number | undefined; timedOut: boolean };

// Gives up on the in-flight edit after waitMs. Inside the cap: the bubble is handed over, and
// the caller edits the bubble in place. After the cap: the turn is detached all the same (msgId cleared, no lines, no
// phase), so the ticker treats the bubble as gone, and the caller deletes it and sends the answer as a new message.
// A late edit then lands on a deleted message and fails, and a late first send sees a newer generation and deletes itself.
export async function takeBubbleCapped<T extends FlushTurn & { msgId?: number }>(
  t: T,
  now: number,
  waitMs: number = TAKEOVER_WAIT_MS,
): Promise<TakenBubble> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, waitMs);
  });
  try {
    while (t.inflight && !timedOut) await Promise.race([t.inflight.catch(() => {}), cap]);
  } finally {
    clearTimeout(timer);
  }
  const id = t.msgId;
  t.msgId = undefined;
  Object.assign(t, detachedProgress(now));
  const gaveUp = timedOut && t.inflight !== undefined;
  // DUR-617 (F2): the abandoned flush may be a first send that has not set msgId yet. The generation changes, and
  // flushProgress deletes whatever it sent under the old one, even if the turn has new content by then.
  // The ticker stalls on this turn until the abandoned call returns (t.sending stays true).
  if (gaveUp) t.gen = (t.gen ?? 0) + 1;
  return { id, timedOut: gaveUp };
}

// DUR-617 (H2): a first send that settles late keeps its message as the bubble only when the turn is still the
// current one, no takeover gave up on it since (same generation), and there is something to show.
export function keepFirstSend(
  t: { gen?: number; lines: string[]; phase: ProgressPhase },
  gen: number,
  isCurrentTurn: boolean,
): boolean {
  return isCurrentTurn && (t.gen ?? 0) === gen && (t.lines.length > 0 || hasPhaseLine(t.phase));
}

export type AnswerApi = {
  edit: (id: number) => Promise<unknown>;
  del: (id: number) => Promise<unknown>;
  send: () => Promise<number>;
};

// DUR-617 (F3): what the reply tool does with a taken bubble. Returns the id of the message that carries the answer.
// In time: edit in place (a refused edit deletes the bubble and sends). After the cap: delete, then send; never edit.
export async function answerViaBubble(taken: TakenBubble, api: AnswerApi): Promise<number> {
  const id = taken.id;
  if (id == null) return send(api);
  if (!taken.timedOut) {
    try {
      await api.edit(id);
      return id;
    } catch {
      // Bubble gone or edit refused: remove it and send normally.
    }
  }
  // Fire and forget: the bubble's Telegram call may be the one that hung, and the answer must not wait for it.
  void api.del(id).catch(() => {});
  return send(api);
}

async function send(api: AnswerApi): Promise<number> {
  try {
    return await api.send();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`reply failed after 0 of 1 chunk(s) sent: ${msg}`);
  }
}

/** DUR-623: where the Working bubble goes for an inbound message. */
export type ProgressTarget = { start: false } | { start: true; thread?: number };

/**
 * A DM gets the bubble (as before). With the topic router on, so does a message in a mapped, non-silent topic of a chat
 * the topic map lists (a mapped forum group), and the bubble then carries that thread id. Any other group (one the map does
 * not list), an unlisted chat, an unmapped topic, a silent topic (another machine's) and General get none. An empty map
 * or the router off is private-only. Any mapped owner qualifies, an agent-owned topic too: a line the Desk could not
 * deliver, a custom command and media fall through to the session, and that turn gets a bubble like any other.
 */
export function progressTarget(i: {
  chatType: string | undefined;
  chatId: string;
  threadId: number | undefined;
  primary: boolean;
  routerOn: boolean;
  map: Record<string, Record<string, { owner: string }>>;
}): ProgressTarget {
  if (!i.primary) return { start: false };
  if (i.chatType === "private") return { start: true };
  if (!i.routerOn || i.threadId == null || (i.chatType !== "supergroup" && i.chatType !== "group"))
    return { start: false };
  const e = i.map[i.chatId]?.[String(i.threadId)];
  if (!e || e.owner === "silent") return { start: false };
  return { start: true, thread: i.threadId };
}
