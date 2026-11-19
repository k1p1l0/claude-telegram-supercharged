// bun test progressTopic.test.ts
// The Working bubble starts in a DM as before, and in a mapped forum topic with that topic's thread id. Another
// group, a group the topic map does not list, an unmapped topic, General, a silent topic and a non-primary bot get
// none. The decision is pure (progressRender.ts); the wiring in server.ts is held by source checks, since server.ts
// starts a bot on import.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keepFirstSend, progressTarget } from "./progressRender";
import { parseTopicMap } from "./topicRouter";

const FORUM = "-1001234567890";
const OTHER = "-4001234567";
const MAP = parseTopicMap(
  JSON.stringify({
    [FORUM]: {
      "40": { name: "Ops", owner: "daemon", requireMention: false },
      "41": { name: "Research", owner: "daemon" },
      "25": { name: "Other machine", owner: "silent" },
    },
  }),
);
const base = { chatType: "supergroup", chatId: FORUM, threadId: 40, primary: true, routerOn: true, map: MAP };

describe("progressTarget", () => {
  test("a DM starts the bubble with no thread, with or without the router", () => {
    for (const routerOn of [true, false]) {
      expect(progressTarget({ ...base, chatType: "private", chatId: "123", threadId: undefined, routerOn })).toEqual({
        start: true,
      });
    }
    expect(progressTarget({ ...base, chatType: "private", chatId: "123", threadId: undefined, map: {} })).toEqual({
      start: true,
    });
  });

  test("a DM on a secondary bot gets none, as before", () => {
    expect(
      progressTarget({ ...base, chatType: "private", chatId: "123", threadId: undefined, primary: false }),
    ).toEqual({
      start: false,
    });
  });

  test("a mapped topic starts the bubble in that thread", () => {
    expect(progressTarget(base)).toEqual({ start: true, thread: 40 });
    expect(progressTarget({ ...base, threadId: 41 })).toEqual({ start: true, thread: 41 });
  });

  test("another group gets none, even with a thread id", () => {
    expect(progressTarget({ ...base, chatId: OTHER, chatType: "group" })).toEqual({ start: false });
    expect(progressTarget({ ...base, chatId: OTHER, chatType: "supergroup", threadId: 40 })).toEqual({ start: false });
  });

  test("a group the map does not list gets none", () => {
    expect(progressTarget({ ...base, chatId: "-1009999999999" })).toEqual({ start: false });
  });

  test("an unmapped topic, General and a silent topic get none", () => {
    expect(progressTarget({ ...base, threadId: 99 })).toEqual({ start: false });
    expect(progressTarget({ ...base, threadId: undefined })).toEqual({ start: false });
    expect(progressTarget({ ...base, threadId: 25 })).toEqual({ start: false });
  });

  test("router off or an empty map keeps groups private-only", () => {
    expect(progressTarget({ ...base, routerOn: false })).toEqual({ start: false });
    expect(progressTarget({ ...base, map: {} })).toEqual({ start: false });
  });

  test("a secondary bot gets none in a mapped topic", () => {
    expect(progressTarget({ ...base, primary: false })).toEqual({ start: false });
  });
});

describe("server.ts wiring", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("deliverMessage asks progressTarget with the topic map and no longer tests private alone", () => {
    expect(server).toContain("progressTarget({");
    expect(server).toContain("map: readTopicMap(),");
    expect(server).toContain("if (bubble.start) startProgressTurn(chat_id, bubble.thread);");
    expect(server).not.toContain('ctx.chat?.type === "private" && b.primary) startProgressTurn');
  });

  test("the first send of the bubble carries the turn's thread id", () => {
    const i = server.indexOf("async function flushProgress");
    const body = server.slice(i, i + 1400);
    expect(body).toContain("...(t.threadId != null ? { message_thread_id: t.threadId } : {}),");
  });

  test("a message mid-turn re-points the open turn at its own thread", () => {
    const i = server.indexOf("function startProgressTurn");
    expect(server.slice(i, i + 1900)).toContain("existing.threadId = threadId;");
  });

  test("a first send for topic A is discarded once a message from topic B bumps the generation", () => {
    const t = { gen: 0, lines: ["x"], phase: "tool" as const };
    const sentGen = t.gen;
    expect(keepFirstSend(t, sentGen, true)).toBe(true);
    t.gen = (t.gen ?? 0) + 1; // what startProgressTurn does when the thread changes
    expect(keepFirstSend(t, sentGen, true)).toBe(false);
    const i = server.indexOf("function startProgressTurn");
    expect(server.slice(i, i + 1200)).toContain(
      "if (existing.threadId !== threadId) existing.gen = (existing.gen ?? 0) + 1;",
    );
  });

  test("a topic that turns silent or leaves the map mid-turn stops qualifying", () => {
    expect(progressTarget(base)).toEqual({ start: true, thread: 40 });
    const silent = parseTopicMap(JSON.stringify({ [FORUM]: { "40": { name: "Ops", owner: "silent" } } }));
    expect(progressTarget({ ...base, map: silent })).toEqual({ start: false });
    expect(progressTarget({ ...base, map: {} })).toEqual({ start: false });
    expect(progressTarget({ ...base, routerOn: false })).toEqual({ start: false });
  });

  test("flushProgress and the ticker revalidate the topic before sending", () => {
    const i = server.indexOf("async function flushProgress");
    expect(server.slice(i, i + 200)).toContain("if (topicBubbleRetired(t)) return;");
    const j = server.indexOf("function topicBubbleRetired");
    const body = server.slice(j, j + 900);
    expect(body).toContain("readTopicMap()");
    expect(body).toContain("deleteProgressBubble(t)");
    expect(server).toContain("if (t.paused || topicBubbleRetired(t)) continue;");
  });

  test("the answer takes over the bubble only in the thread the bubble lives in, and the fallback send keeps the thread", () => {
    expect(server).toContain("thread_id === progressTurns.get(chat_id)?.threadId");
    const i = server.indexOf("send: async () =>");
    expect(server.slice(i, i + 400)).toContain("message_thread_id: thread_id");
  });

  test("a delivered message with no bubble (unmapped topic, General, other group) retires every live topic bubble", () => {
    expect(server).toContain(
      "if (bubble.start) startProgressTurn(chat_id, bubble.thread);\n  else retireTopicBubbles();",
    );
    const i = server.indexOf("function retireTopicBubbles");
    const body = server.slice(i, i + 300);
    expect(body).toContain("t.threadId != null && !t.retired");
    expect(body).toContain("retireTopicBubble(t)");
  });

  test("retiring deletes the bubble and bumps the generation so an in-flight send is discarded", () => {
    const i = server.indexOf("function retireTopicBubble(");
    const body = server.slice(i, i + 250);
    expect(body).toContain("t.retired = true;");
    expect(body).toContain("t.gen = (t.gen ?? 0) + 1;");
    expect(body).toContain("deleteProgressBubble(t);");
  });

  test("progress events are not collected into a retired topic turn", () => {
    expect(server).toContain("if (!t || t.retired) return; // a retired topic turn collects nothing");
  });

  test("a retired turn that restarts, or a turn that moves to another topic, starts with empty progress", () => {
    const i = server.indexOf("function startProgressTurn");
    const body = server.slice(i, i + 1900);
    expect(body).toContain("if (existing.retired || existing.threadId !== threadId) {");
    for (const reset of [
      "existing.lines = [];",
      "existing.hidden = 0;",
      "existing.tools = 0;",
      "existing.dirty = false;",
      "existing.lastSentAt = at;",
    ])
      expect(body).toContain(reset);
    expect(body.indexOf("existing.lines = [];")).toBeLessThan(body.indexOf("existing.retired = false;"));
    expect(body).toContain("existing.retired = false;");
  });
});
