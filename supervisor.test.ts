// bun test supervisor.test.ts
// The restart gate: when the session counts as busy, which messages a restart lost, and
// who gets the "send it again" notice. Pure functions only: no process, no files, no network.
import { describe, expect, test } from "bun:test";
import {
  type AccessRules,
  type MessageRow,
  hookActivity,
  noticeTargets,
  parseProgress,
  parseRestartSignal,
  unansweredMessages,
} from "./supervisor";

const MIN = 60_000;
const T0 = 1_800_000_000_000; // session start, ms

function row(over: Partial<MessageRow>): MessageRow {
  return {
    message_id: 1,
    chat_id: "100",
    user_id: "100",
    text: "hi",
    caption: null,
    reply_to_msg_id: null,
    date: T0 / 1000 + 10,
    is_outgoing: 0,
    thread_id: null,
    bot: "",
    ...over,
  };
}

describe("parseProgress", () => {
  test("keeps this session's events and skips bad lines", () => {
    const text = [
      JSON.stringify({ t: T0 - 5, type: "tool", tool: "Bash" }), // previous session
      "not json",
      JSON.stringify({ t: T0 + 1, type: "tool", tool: "Read" }),
      JSON.stringify({ type: "stop" }), // no time
      JSON.stringify({ t: T0 + 2, type: "stop" }),
      "",
    ].join("\n");
    expect(parseProgress(text, T0).map((e) => e.type)).toEqual(["tool", "stop"]);
  });
});

describe("hookActivity", () => {
  test("no events: not busy, no stop seen", () => {
    expect(hookActivity([], T0)).toEqual({ busy: false, reason: "", lastStop: null });
  });

  test("a stop with nothing after it: idle, after a short grace for a queued message", () => {
    const events = [
      { t: T0 + 1000, type: "tool", tool: "Bash" },
      { t: T0 + 2000, type: "tool_done", tool: "Bash" },
      { t: T0 + 3000, type: "stop" },
    ];
    expect(hookActivity(events, T0 + 4000).busy).toBe(true);
    const a = hookActivity(events, T0 + 3000 + 16_000);
    expect(a.busy).toBe(false);
    expect(a.lastStop).toBe(T0 + 3000);
  });

  test("an 'On it' reply and then thinking: the turn is still in flight", () => {
    const events = [
      { t: T0 + 1000, type: "stop" },
      { t: T0 + 60_000, type: "own" }, // reply tool, before
      { t: T0 + 60_500, type: "own" }, // reply tool, after
    ];
    expect(hookActivity(events, T0 + 60_500 + 2 * MIN).busy).toBe(true);
    expect(hookActivity(events, T0 + 60_500 + 4 * MIN).busy).toBe(false);
    // The stop ends it.
    expect(hookActivity([...events, { t: T0 + 90_000, type: "stop" }], T0 + 90_000 + 16_000).busy).toBe(false);
  });

  test("a tool call with no result: busy, also minutes later", () => {
    const events = [
      { t: T0 + 1000, type: "stop" },
      { t: T0 + 2000, type: "tool", tool: "Bash" },
    ];
    const a = hookActivity(events, T0 + 2000 + 9 * MIN);
    expect(a.busy).toBe(true);
    expect(a.reason).toContain("Bash");
    expect(a.lastStop).toBe(T0 + 1000);
    // A call that never reported a result stops counting, so a hung session still restarts.
    expect(hookActivity(events, T0 + 2000 + 11 * MIN).busy).toBe(false);
  });

  test("between tool calls: busy for a short time only", () => {
    const events = [
      { t: T0 + 1000, type: "tool", tool: "Read" },
      { t: T0 + 2000, type: "tool_done", tool: "Read" },
    ];
    expect(hookActivity(events, T0 + 2000 + 2 * MIN).busy).toBe(true);
    expect(hookActivity(events, T0 + 2000 + 4 * MIN).busy).toBe(false);
  });

  test("parallel calls: one result back, the other still runs", () => {
    const events = [
      { t: T0 + 1000, type: "tool", tool: "Agent" },
      { t: T0 + 1100, type: "tool", tool: "Read" },
      { t: T0 + 1200, type: "tool_done", tool: "Read" },
    ];
    const a = hookActivity(events, T0 + 1200 + 8 * MIN);
    expect(a.busy).toBe(true);
    expect(a.reason).toContain("tool call in flight");
  });

  test("a new turn after a stop is busy again", () => {
    const a = hookActivity(
      [
        { t: T0 + 1000, type: "stop" },
        { t: T0 + 5000, type: "tool", tool: "WebSearch" },
      ],
      T0 + 6000,
    );
    expect(a.busy).toBe(true);
    expect(a.lastStop).toBe(T0 + 1000);
  });
});

describe("unansweredMessages", () => {
  const access: AccessRules = {
    allowFrom: ["100"],
    groups: {
      "-200": { requireMention: true, allowFrom: [] },
      "-300": { requireMention: false, allowFrom: ["7"] },
    },
    mentionPatterns: ["^claude\\b"],
  };
  const since = T0;

  test("an allowlisted DM with no answer is pending", () => {
    const got = unansweredMessages([row({})], access, "mybot", since);
    expect(got).toHaveLength(1);
    expect(got[0].group).toBe(false);
  });

  test("answered, older than the window, unknown chat, own rows: not pending", () => {
    const rows = [
      row({ message_id: 1, date: T0 / 1000 + 10 }),
      row({ message_id: 2, date: T0 / 1000 + 12, is_outgoing: 1 }), // the answer
      row({ message_id: 3, date: T0 / 1000 - 5 }), // before the last turn ended
      row({ message_id: 4, chat_id: "999", user_id: "999", date: T0 / 1000 + 20 }), // not allowlisted
      row({ message_id: -5, chat_id: "555", date: T0 / 1000 + 20 }), // a button tap row
    ];
    expect(unansweredMessages(rows, { ...access, allowFrom: ["100", "555"] }, "mybot", since)).toEqual([]);
  });

  test("an answer in another chat doesn't count", () => {
    const rows = [row({ message_id: 1 }), row({ message_id: 2, chat_id: "-300", date: T0 / 1000 + 30, is_outgoing: 1 })];
    expect(unansweredMessages(rows, access, "mybot", since)).toHaveLength(1);
  });

  test("a group that requires a mention: @mention, reply to the bot, or a mention pattern", () => {
    const g = { chat_id: "-200", user_id: "42" };
    const rows = [
      row({ ...g, message_id: 1, text: "just talking" }),
      row({ ...g, message_id: 2, text: "hey @MyBot look" }),
      row({ ...g, message_id: 3, text: "and this?", reply_to_msg_id: 77 }),
      row({ ...g, message_id: 4, text: "and that?", reply_to_msg_id: 78 }), // a reply to a person
      row({ ...g, message_id: 5, text: null, caption: "Claude, read it" }),
    ];
    const got = unansweredMessages(rows, access, "mybot", since, (_c, _b, id) => id === 77);
    expect(got.map((m) => m.message_id)).toEqual([2, 3, 5]);
    expect(got.every((m) => m.group)).toBe(true);
  });

  test("a group without a mention rule: only its allowed senders, and it records who addressed the bot", () => {
    const rows = [
      row({ chat_id: "-300", user_id: "7", message_id: 1 }),
      row({ chat_id: "-300", user_id: "8", message_id: 2 }),
      row({ chat_id: "-300", user_id: "7", message_id: 3, text: "@mybot print this" }),
    ];
    const got = unansweredMessages(rows, access, "mybot", since);
    expect(got.map((m) => [m.message_id, m.addressed])).toEqual([
      [1, false],
      [3, true],
    ]);
  });

  test("an extra bot uses its own rules and its own answers", () => {
    const multi: AccessRules = { ...access, bots: { "@SideBot": { allowFrom: ["500"] } } };
    const rows = [
      row({ message_id: 1, chat_id: "500", bot: "sidebot" }), // allowed for the extra bot
      row({ message_id: 2, chat_id: "100", bot: "sidebot" }), // allowed for the primary only
      row({ message_id: 3, chat_id: "500", bot: "", date: T0 / 1000 + 40, is_outgoing: 1 }), // the primary's answer
    ];
    expect(unansweredMessages(rows, multi, "mybot", since).map((m) => m.message_id)).toEqual([1]);
  });
});

describe("noticeTargets", () => {
  const replayAt = T0 / 1000 + 1000;
  const pending = (over: Partial<MessageRow>, group = false, addressed = true) => ({ ...row(over), group, addressed });

  test("a group message that isn't for the bot gets no notice", () => {
    expect(noticeTargets([pending({ chat_id: "-300", date: replayAt - 30 }, true, false)], replayAt)).toEqual([]);
  });

  test("a fresh DM is left to the replay", () => {
    expect(noticeTargets([pending({ date: replayAt - 60 })], replayAt)).toEqual([]);
  });

  test("a DM older than the replay window gets the notice", () => {
    expect(noticeTargets([pending({ date: replayAt - 301 })], replayAt)).toHaveLength(1);
  });

  test("a group message for the bot gets the notice, once per chat and topic", () => {
    const got = noticeTargets(
      [
        pending({ chat_id: "-200", message_id: 1, date: replayAt - 30 }, true),
        pending({ chat_id: "-200", message_id: 2, date: replayAt - 20 }, true),
        pending({ chat_id: "-200", message_id: 3, date: replayAt - 25, thread_id: 9 }, true),
      ],
      replayAt,
    );
    expect(got.map((m) => m.message_id).sort()).toEqual([2, 3]);
  });
});

describe("parseRestartSignal", () => {
  test("a timestamp in the future sets the delay", () => {
    expect(parseRestartSignal(`${T0 + 2000}\n`, T0)).toEqual({ delayMs: 2000, force: false });
  });

  test("the now flag skips the idle wait", () => {
    expect(parseRestartSignal(`${T0 + 1000} now\n`, T0)).toEqual({ delayMs: 1000, force: true });
  });

  test("an empty or old file uses the default delay", () => {
    expect(parseRestartSignal("", T0)).toEqual({ delayMs: 3000, force: false });
    expect(parseRestartSignal(`${T0 - 1}`, T0)).toEqual({ delayMs: 3000, force: false });
  });
});
