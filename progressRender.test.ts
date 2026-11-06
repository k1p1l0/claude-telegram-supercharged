import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BubbleStyle,
  PROGRESS_EMOJI_ID,
  PROGRESS_VERBS,
  PROGRESS_VERB_MS,
  TAKEOVER_WAIT_MS,
  answerViaBubble,
  detachedProgress,
  fallBackOnEntityError,
  formatElapsed,
  hasPhaseLine,
  isEntityError,
  keepFirstSend,
  progressVerb,
  renderBubble,
  spinEnabled,
  takeBubbleCapped,
  takeoverEditOptions,
  trackFlush,
} from "./progressRender";

const T0 = 1_000_000_000; // a whole number of seconds, so the verb index is easy to compute
const turn = (phase: "tool" | "thinking" | "writing" | "idle", lines: string[] = [], hidden = 0) => ({
  startedAt: T0,
  lines,
  hidden,
  phase,
});
const first = (text: string) => text.split("\n")[0];
const on = (): BubbleStyle => ({ custom: true });

describe("DUR-615: the Working bubble header", () => {
  test("elapsed time reads 12s, then 1m 12s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(59_400)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(72_000)).toBe("1m 12s");
    expect(formatElapsed(-5000)).toBe("0s");
  });

  test("the verb changes every 6 s, walks the list in order and wraps", () => {
    const base = Math.floor(T0 / 1000);
    const at = (ms: number) => progressVerb(T0, T0 + ms);
    expect(at(0)).toBe(PROGRESS_VERBS[base % 30]);
    expect(at(PROGRESS_VERB_MS - 1)).toBe(at(0));
    expect(at(PROGRESS_VERB_MS)).toBe(PROGRESS_VERBS[(base + 1) % 30]);
    expect(at(30 * PROGRESS_VERB_MS)).toBe(at(0));
    expect(PROGRESS_VERBS.length).toBe(30);
    expect(new Set(PROGRESS_VERBS).size).toBe(30);
  });

  test("a clock before the start gives the first verb, not an index out of range", () => {
    expect(progressVerb(T0, T0 - 9000)).toBe(progressVerb(T0, T0));
  });

  test("the first line is emoji, verb, ellipsis and time", () => {
    const v = renderBubble(turn("tool", ["x"]), T0 + 72_000, true, on());
    const verb = progressVerb(T0, T0 + 72_000);
    expect(first(v.text)).toBe(`💬 ${verb}… (1m 12s)`);
  });

  test("entities: custom emoji on the base character, bold on the verb with its ellipsis", () => {
    const v = renderBubble(turn("tool", ["x"]), T0 + 12_000, true, on());
    const verb = progressVerb(T0, T0 + 12_000);
    expect(v.entities).toEqual([
      { type: "custom_emoji", offset: 0, length: 2, custom_emoji_id: PROGRESS_EMOJI_ID },
      { type: "bold", offset: 3, length: verb.length + 1 },
    ]);
    // Telegram counts UTF-16 units, as a JS string does: the slices must land on the emoji and the verb.
    expect(v.text.slice(0, 2)).toBe("💬");
    expect(v.text.slice(3, 3 + verb.length + 1)).toBe(`${verb}…`);
  });

  test("fallback: after one entity refusal the bubble keeps the plain emoji and the bold, with no custom entity", () => {
    const style = on();
    expect(fallBackOnEntityError(style, { description: "Bad Request: can't parse entities" })).toBe(true);
    expect(style.custom).toBe(false);
    const v = renderBubble(turn("tool", ["x"]), T0 + 1000, true, style);
    expect(first(v.text).startsWith("💬 ")).toBe(true);
    expect(v.entities?.map((e) => e.type)).toEqual(["bold"]);
    expect(fallBackOnEntityError(style, { description: "custom emoji" })).toBe(false); // already off: no second dirty
  });

  test("fallback ignores errors that are not about entities", () => {
    const style = on();
    expect(fallBackOnEntityError(style, { description: "Too Many Requests: retry after 3" })).toBe(false);
    expect(fallBackOnEntityError(style, new Error("message is not modified"))).toBe(false);
    expect(style.custom).toBe(true);
    expect(isEntityError({ description: "DOCUMENT_INVALID: custom emoji not allowed" })).toBe(true);
    expect(isEntityError("Bad Request: can't parse entities in message text")).toBe(true);
  });

  test("tool lines, the hidden count and the phase line follow the header", () => {
    const v = renderBubble(turn("thinking", ["🔧 a", "💬 b"], 3), T0 + 1000, true, on());
    expect(v.text.split("\n").slice(1)).toEqual(["… 3 earlier", "🔧 a", "💬 b", "💭 Thinking…"]);
    expect(renderBubble(turn("writing"), T0, true, on()).text.endsWith("✍️ Writing…")).toBe(true);
  });

  test("spin off gives the old static bubble with no entities", () => {
    const v = renderBubble(turn("thinking", ["🔧 a"]), T0 + 400_000, false, on());
    expect(v).toEqual({ text: "Working... (400s)\n🔧 a\n💭 Thinking…" });
  });

  test("the text changes between two ticks, so Telegram never answers not-modified", () => {
    const a = renderBubble(turn("thinking"), T0 + 3000, true, on()).text;
    const b = renderBubble(turn("thinking"), T0 + 4000, true, on()).text;
    expect(a).not.toBe(b);
  });

  test("hasPhaseLine and the env switch", () => {
    expect(hasPhaseLine("thinking") && hasPhaseLine("writing")).toBe(true);
    expect(hasPhaseLine("tool") || hasPhaseLine("idle")).toBe(false);
    expect(spinEnabled(undefined)).toBe(true);
    expect(spinEnabled("on")).toBe(true);
    expect(spinEnabled("off")).toBe(false);
    expect(spinEnabled(" OFF ")).toBe(false);
  });
});

describe("DUR-615: the answer takes over the whole bubble", () => {
  test("the edit options carry the reply's own parse mode and extras, and no entities", () => {
    const keyboard = { reply_markup: { inline_keyboard: [] } };
    const o = takeoverEditOptions("MarkdownV2", keyboard);
    expect(o).toEqual({ parse_mode: "MarkdownV2", reply_markup: keyboard.reply_markup });
    expect("entities" in o).toBe(false);
    expect(takeoverEditOptions(undefined, {})).toEqual({});
  });

  test("the bubble has entities, the takeover options never do", () => {
    const bubble = renderBubble(turn("tool", ["x"]), T0 + 5000, true, on());
    expect(bubble.entities?.length).toBeGreaterThan(0);
    expect(Object.keys(takeoverEditOptions("HTML", {}))).toEqual(["parse_mode"]);
  });

  test("the detached state has no lines, no phase line, nothing dirty", () => {
    const d = detachedProgress(42);
    expect(d).toEqual({ lines: [], hidden: 0, dirty: false, phase: "idle", lastSentAt: 42, lastTyping: 42 });
    expect(hasPhaseLine(d.phase)).toBe(false);
  });
});

describe("DUR-615: the answer waits for the in-flight bubble edit", () => {
  const mkTurn = () => ({
    sending: false,
    inflight: undefined as Promise<void> | undefined,
    msgId: undefined as number | undefined,
    lines: ["x"],
    hidden: 2,
    dirty: true,
    phase: "thinking" as "tool" | "thinking" | "writing" | "idle",
    lastSentAt: 0,
    lastTyping: 0,
  });

  test("a first send that is slow has set the message id before the answer takes it", async () => {
    const t = mkTurn();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    void trackFlush(t, async () => {
      await gate; // Telegram answers slower than any fixed wait
      t.msgId = 77;
    });
    expect(t.sending).toBe(true);
    let taken: number | undefined = -1;
    const done = takeBubbleCapped(t, 5, 60_000).then((r) => {
      taken = r.id;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(taken).toBe(-1); // still waiting: no timeout gave up on the flush
    release();
    await done;
    expect(taken).toBe(77);
    expect(t.msgId).toBeUndefined();
    expect(t.sending).toBe(false);
    expect(t.inflight).toBeUndefined();
    expect(t).toMatchObject({ lines: [], hidden: 0, dirty: false, phase: "idle", lastSentAt: 5 });
  });

  test("no progress edit lands after the takeover: the log shows the edit first, then the answer", async () => {
    const t = mkTurn();
    t.msgId = 9;
    const log: string[] = [];
    void trackFlush(t, async () => {
      await new Promise((r) => setTimeout(r, 40));
      log.push("progress edit");
    });
    const { id } = await takeBubbleCapped(t, 1, 60_000);
    log.push(`answer edit ${id}`);
    expect(log).toEqual(["progress edit", "answer edit 9"]);
  });

  test("a flush that throws still clears the flag and the promise, so the takeover never hangs", async () => {
    const t = mkTurn();
    t.msgId = 3;
    void trackFlush(t, async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect((await takeBubbleCapped(t, 1, 60_000)).id).toBe(3);
    expect(t.sending).toBe(false);
  });

  test("with nothing in flight the takeover returns at once", async () => {
    const t = mkTurn();
    t.msgId = 4;
    expect((await takeBubbleCapped(t, 1, 60_000)).id).toBe(4);
  });
});

describe("DUR-617: the takeover wait is capped", () => {
  const mkTurn = () => ({
    sending: false,
    inflight: undefined as Promise<void> | undefined,
    msgId: undefined as number | undefined,
    lines: ["x"],
    hidden: 2,
    dirty: true,
    phase: "thinking" as "tool" | "thinking" | "writing" | "idle",
    lastSentAt: 0,
    lastTyping: 0,
  });

  test("the cap is 10 s", () => {
    expect(TAKEOVER_WAIT_MS).toBe(10_000);
  });

  test("an edit that returns within the cap: the bubble is handed over for an in-place edit", async () => {
    const t = mkTurn();
    t.msgId = 9;
    const log: string[] = [];
    void trackFlush(t, async () => {
      await new Promise((r) => setTimeout(r, 20));
      log.push("progress edit");
    });
    const r = await takeBubbleCapped(t, 1, 500);
    log.push(`answer edit ${r.id}`);
    expect(r).toEqual({ id: 9, timedOut: false });
    expect(log).toEqual(["progress edit", "answer edit 9"]);
    expect(t.msgId).toBeUndefined();
    expect(t).toMatchObject({ lines: [], hidden: 0, dirty: false, phase: "idle", lastSentAt: 1 });
  });

  test("with nothing in flight it returns at once and not timed out", async () => {
    const t = mkTurn();
    t.msgId = 4;
    expect(await takeBubbleCapped(t, 1, 500)).toEqual({ id: 4, timedOut: false });
  });

  test("an edit stuck past the cap: the takeover returns timed out, with the id to delete, and the turn is detached", async () => {
    const t = mkTurn();
    t.msgId = 12;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    void trackFlush(t, async () => {
      await gate;
    });
    const started = Date.now();
    const r = await takeBubbleCapped(t, 7, 40);
    expect(Date.now() - started).toBeLessThan(500);
    expect(r).toEqual({ id: 12, timedOut: true });
    expect(t.msgId).toBeUndefined();
    expect(t).toMatchObject({ lines: [], hidden: 0, dirty: false, phase: "idle", lastSentAt: 7 });
    expect(hasPhaseLine(t.phase)).toBe(false);
    release();
  });

  test("a late edit cannot bring the bubble back: the detached turn has no id and no content afterwards", async () => {
    const t = mkTurn();
    t.msgId = 12;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Same shape as flushProgress: a late first send only keeps its message when the turn still has content.
    let kept: number | undefined;
    const lateEdit = trackFlush(t, async () => {
      await gate;
      if (t.lines.length > 0 || hasPhaseLine(t.phase)) kept = 99;
    });
    const r = await takeBubbleCapped(t, 7, 30);
    expect(r.timedOut).toBe(true);
    release();
    await lateEdit;
    expect(kept).toBeUndefined();
    expect(t.msgId).toBeUndefined();
    expect(t.sending).toBe(false);
    expect(t.inflight).toBeUndefined();
  });

  test("a first send in flight at the cap: content pushed before it settles does not keep the message (generation)", async () => {
    const t = { ...mkTurn(), gen: 0 };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deleted: number[] = [];
    // Same call as flushProgress: remember the generation before the send, ask keepFirstSend after it.
    const gen = t.gen;
    const lateSend = trackFlush(t, async () => {
      await gate;
      const sentId = 55;
      if (keepFirstSend(t, gen, true)) t.msgId = sentId;
      else deleted.push(sentId);
    });
    const r = await takeBubbleCapped(t, 7, 30);
    expect(r).toEqual({ id: undefined, timedOut: true });
    t.lines.push("Read x"); // a tool event lands before the send settles
    t.phase = "tool";
    release();
    await lateSend;
    expect(t.msgId).toBeUndefined();
    expect(deleted).toEqual([55]);
  });

  test("keepFirstSend: the generation term decides, whatever the content", () => {
    const t = { gen: 1, lines: ["Read x"], phase: "tool" as const };
    expect(keepFirstSend(t, 1, true)).toBe(true);
    expect(keepFirstSend(t, 0, true)).toBe(false); // an older generation, though there is content
    expect(keepFirstSend(t, 1, false)).toBe(false); // not the current turn
    expect(keepFirstSend({ gen: 1, lines: [], phase: "idle" as const }, 1, true)).toBe(false); // nothing to show
    expect(keepFirstSend({ lines: ["x"], phase: "tool" as const }, 0, true)).toBe(true); // no gen yet counts as 0
  });

  test("a flush that fails inside the cap is not a timeout", async () => {
    const t = mkTurn();
    t.msgId = 3;
    void trackFlush(t, async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(await takeBubbleCapped(t, 1, 500)).toEqual({ id: 3, timedOut: false });
  });
});

describe("DUR-617: what the reply tool does with a taken bubble", () => {
  const mk = (editFails = false) => {
    const calls: string[] = [];
    return {
      calls,
      api: {
        edit: async (id: number) => {
          calls.push(`edit ${id}`);
          if (editFails) throw new Error("refused");
        },
        del: async (id: number) => {
          calls.push(`delete ${id}`);
        },
        send: async () => {
          calls.push("send");
          return 200;
        },
      },
    };
  };

  test("in time: edits in place and sends nothing", async () => {
    const m = mk();
    expect(await answerViaBubble({ id: 9, timedOut: false }, m.api)).toBe(9);
    expect(m.calls).toEqual(["edit 9"]);
  });

  test("after the cap: deletes the bubble, then sends the answer, and never edits", async () => {
    const m = mk();
    expect(await answerViaBubble({ id: 9, timedOut: true }, m.api)).toBe(200);
    expect(m.calls).toEqual(["delete 9", "send"]);
  });

  test("after the cap a failing delete is ignored and the answer is still sent", async () => {
    const m = mk();
    m.api.del = async () => {
      m.calls.push("delete 9");
      throw new Error("gone");
    };
    expect(await answerViaBubble({ id: 9, timedOut: true }, m.api)).toBe(200);
    expect(m.calls).toEqual(["delete 9", "send"]);
  });

  test("after the cap a delete that never returns does not hold the answer", async () => {
    const m = mk();
    m.api.del = (id: number) => {
      m.calls.push(`delete ${id}`);
      return new Promise(() => {});
    };
    expect(await answerViaBubble({ id: 9, timedOut: true }, m.api)).toBe(200);
    expect(m.calls).toEqual(["delete 9", "send"]);
  });

  test("a send failure reads like the chunk loop's", async () => {
    const m = mk();
    m.api.send = async () => {
      throw new Error("boom");
    };
    await expect(answerViaBubble({ id: 9, timedOut: true }, m.api)).rejects.toThrow(
      "reply failed after 0 of 1 chunk(s) sent: boom",
    );
  });

  test("in time but the edit is refused: deletes and sends", async () => {
    const m = mk(true);
    expect(await answerViaBubble({ id: 9, timedOut: false }, m.api)).toBe(200);
    expect(m.calls).toEqual(["edit 9", "delete 9", "send"]);
  });

  test("no bubble id: plain send", async () => {
    const m = mk();
    expect(await answerViaBubble({ id: undefined, timedOut: true }, m.api)).toBe(200);
    expect(m.calls).toEqual(["send"]);
  });
});

describe("DUR-615: wiring in server.ts (source checks only; the behaviour is tested above)", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf-8");
  test("the ticker flushes at the floor when spin is on, and the floor stays 1500", () => {
    expect(src).toContain("const PROGRESS_EDIT_MS = 1500;");
    expect(src).toContain("if (now - t.lastEdit < PROGRESS_EDIT_MS) continue;");
    expect(src).toContain("if (t.dirty || PROGRESS_SPIN || now - t.lastEdit >= 3000) void flushProgress(t);");
  });
  test("the switch is read once from the env", () => {
    expect(src).toContain("const PROGRESS_SPIN = spinEnabled(process.env.TELEGRAM_PROGRESS_SPIN);");
  });
  test("the server uses the pure functions", () => {
    expect(src).toContain("return takeBubbleCapped(t, Date.now(), TAKEOVER_WAIT_MS);");
    expect(src).toContain("await answerViaBubble(taken, {");
    expect(src).toContain("keepFirstSend(t, gen, progressTurns.get(t.chatId) === t)");
    expect(src).toContain("await trackFlush(t, async () => {");
    expect(src).toContain("takeoverEditOptions(parseMode, {})");
    expect(src).toContain("fallBackOnEntityError(progressStyle, err)");
  });
});
