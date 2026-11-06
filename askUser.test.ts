// bun test askUser.test.ts
// ask_user posts inside a forum topic. The helpers are pure; the wiring in server.ts is held by source checks,
// since server.ts starts a bot on import.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  askUserSendOptions,
  askUserSilentCheck,
  askUserThreadEnabled,
  askUserThreadId,
  resolveAskCallback,
} from "./askUser";

const KB = { inline_keyboard: [] };
const never = () => false;

describe("askUserSendOptions", () => {
  test("with a thread the options carry message_thread_id", () => {
    expect(askUserSendOptions(599, "HTML", KB)).toEqual({
      parse_mode: "HTML",
      message_thread_id: 599,
      reply_markup: KB,
    });
  });
  test("without a thread there is no message_thread_id", () => {
    const o = askUserSendOptions(undefined, "MarkdownV2", KB);
    expect("message_thread_id" in o).toBe(false);
    expect(o).toEqual({ parse_mode: "MarkdownV2", reply_markup: KB });
  });
  test("plain text sets no parse_mode", () => {
    expect("parse_mode" in askUserSendOptions(7, undefined, KB)).toBe(false);
  });
});

describe("askUserThreadEnabled", () => {
  test("only the exact value on turns it on, and unset is off", () => {
    expect(askUserThreadEnabled({ TELEGRAM_ASK_USER_THREAD: "on" })).toBe(true);
    for (const v of [undefined, "", "off", "ON", "1", "true", " on"]) {
      expect(askUserThreadEnabled({ TELEGRAM_ASK_USER_THREAD: v })).toBe(false);
    }
    expect(askUserThreadEnabled({})).toBe(false);
  });
  test("the router flag does not turn it on", () => {
    expect(askUserThreadEnabled({ TELEGRAM_TOPIC_ROUTER: "on" })).toBe(false);
  });
});

describe("askUserThreadId, flag on", () => {
  test("no thread gives undefined and never asks the silent check", () => {
    let asked = false;
    expect(
      askUserThreadId(undefined, true, () => {
        asked = true;
        return true;
      }),
    ).toBeUndefined();
    expect(asked).toBe(false);
  });
  test("a number or numeric string is accepted", () => {
    expect(askUserThreadId(599, true, never)).toBe(599);
    expect(askUserThreadId("599", true, never)).toBe(599);
  });
  test("a silent topic is refused", () => {
    expect(() => askUserThreadId(599, true, (t) => t === 599)).toThrow("topic is silent");
  });
  test("anything but a positive whole number is refused", () => {
    for (const bad of ["abc", "", "  ", 0, "0", 1.5, "1.5", -3, "-3", Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(() => askUserThreadId(bad, true, never)).toThrow("thread_id must be a positive whole number");
    }
  });
});

describe("flag on, router flag on or off (the server.ts composition)", () => {
  const silentInMap = (t: number) => t === 599;
  test("ask flag on, router off: a topic the map calls silent still gets the question", () => {
    expect(askUserThreadId(599, true, askUserSilentCheck(false, silentInMap))).toBe(599);
  });
  test("ask flag on, router on: a silent topic is refused, another topic is not", () => {
    expect(() => askUserThreadId(599, true, askUserSilentCheck(true, silentInMap))).toThrow("topic is silent");
    expect(askUserThreadId(600, true, askUserSilentCheck(true, silentInMap))).toBe(600);
  });
  test("ask flag off, router on: the silent topic changes nothing", () => {
    expect(askUserThreadId(599, false, askUserSilentCheck(true, silentInMap))).toBeUndefined();
  });
});

describe("askUserThreadId, flag off", () => {
  test("thread_id is ignored whatever it holds, with no silent check and no throw", () => {
    let asked = false;
    const silent = () => {
      asked = true;
      return true;
    };
    for (const v of [undefined, 599, "599", "abc", "", 0, -3, 1.5, true, {}]) {
      expect(askUserThreadId(v, false, silent)).toBeUndefined();
    }
    expect(asked).toBe(false);
  });
  test("the send options are then the old ones, with no message_thread_id", () => {
    const o = askUserSendOptions(askUserThreadId(599, false, never), "MarkdownV2", KB);
    expect(o).toEqual({ parse_mode: "MarkdownV2", reply_markup: KB });
    expect("message_thread_id" in o).toBe(false);
  });
});

describe("resolveAskCallback", () => {
  const make = () => {
    const got: string[] = [];
    const timer = setTimeout(() => got.push("timer fired"), 60_000);
    const pending = new Map([["abc123", { resolve: (v: string) => got.push(v), timer }]]);
    return { got, pending };
  };
  test("a tap on ask:<id>:<label> resolves the pending question with the label and removes it", () => {
    const { got, pending } = make();
    expect(resolveAskCallback(pending, "ask:abc123:Yes")).toEqual({ label: "Yes", resolved: true });
    expect(got).toEqual(["Yes"]);
    expect(pending.size).toBe(0);
  });
  test("a label that contains a colon is kept whole", () => {
    const { got, pending } = make();
    resolveAskCallback(pending, "ask:abc123:Plan: B");
    expect(got).toEqual(["Plan: B"]);
  });
  test("an unknown id resolves nothing", () => {
    const { got, pending } = make();
    expect(resolveAskCallback(pending, "ask:zzz:Yes")).toEqual({ label: "Yes", resolved: false });
    expect(got).toEqual([]);
    expect(pending.size).toBe(1);
    clearTimeout(pending.get("abc123")?.timer);
  });
  test("data that is not an ask tap gives null", () => {
    const { got, pending } = make();
    expect(resolveAskCallback(pending, "dec:D1:a")).toBeNull();
    expect(resolveAskCallback(pending, "ask:abc123")).toBeNull();
    expect(got).toEqual([]);
    clearTimeout(pending.get("abc123")?.timer);
  });
});

describe("server.ts wiring", () => {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const handler = src.slice(src.indexOf('case "ask_user": {'), src.indexOf('case "get_history": {'));
  test("schema has a numeric thread_id", () => {
    const schema = src.slice(src.indexOf('name: "ask_user"'), src.indexOf('name: "get_history"'));
    expect(schema.replace(/\s+/g, " ")).toMatch(/thread_id: \{ type: "number",/);
  });
  test("handler checks the silent topic and passes the thread on sendMessage", () => {
    expect(handler).toContain("askUserThreadEnabled()");
    expect(handler).toContain(
      "askUserSilentCheck(topicRouterEnabled(), (t) => topicIsSilent(readTopicMap(), chat_id, t))",
    );
    expect(handler).toContain("askUserSendOptions(askThread, parseMode, keyboard)");
  });
  test("the callback path and the returned text are unchanged", () => {
    expect(handler).toContain("`ask:${callbackId}:${label}`");
    expect(handler).toContain("`user chose: ${choice}`");
    expect(src).toContain("resolveAskCallback(pendingCallbacks, data)");
  });
});
