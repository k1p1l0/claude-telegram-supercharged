// bun test topicRouter.test.ts
// The topic router for a forum supergroup. The lookup, the hot-reloaded map and the outbound thread are pure
// (topicRouter.ts); the wiring in server.ts is held by source checks, since server.ts starts a bot on import.
// Temp folders only; nothing is deleted.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTopicMapReader,
  outboundThread,
  parseTopicMap,
  pregateKeyOf,
  topicIsSilent,
  topicRoute,
  topicRouterEnabled,
} from "./topicRouter";

const GROUP = "-1001234567890";
const MAP = parseTopicMap(
  JSON.stringify({
    [GROUP]: {
      "40": { name: "Ops", owner: "daemon", requireMention: false },
      "41": { name: "Research", owner: "daemon" },
      "25": { name: "Other machine", owner: "silent" },
    },
  }),
);

describe("topicRoute", () => {
  test("silent drops the message: no delivery at all", () => {
    expect(topicRoute(MAP, GROUP, 25, true)).toEqual({ kind: "drop" });
    expect(topicRoute(MAP, GROUP, "25", false)).toEqual({ kind: "drop" });
  });

  test("a mapped topic overrides the group's requireMention in both directions", () => {
    expect(topicRoute(MAP, GROUP, 40, true)).toMatchObject({ requireMention: false, owner: "daemon", name: "Ops" });
    const strict = parseTopicMap(
      JSON.stringify({ [GROUP]: { "7": { name: "Quiet", owner: "daemon", requireMention: true } } }),
    );
    expect(topicRoute(strict, GROUP, 7, false)).toMatchObject({ requireMention: true });
  });

  test("a mapped topic without requireMention keeps the group's value", () => {
    expect(topicRoute(MAP, GROUP, 41, true)).toMatchObject({ requireMention: true, name: "Research", mapped: true });
    expect(topicRoute(MAP, GROUP, 41, false)).toMatchObject({ requireMention: false });
  });

  test("an unknown topic, no thread id and an unknown chat fall back to the group rule with owner daemon", () => {
    for (const r of [
      topicRoute(MAP, GROUP, 999, true),
      topicRoute(MAP, GROUP, undefined, true),
      topicRoute(MAP, "-1", 40, true),
    ]) {
      expect(r).toEqual({ kind: "deliver", owner: "daemon", name: null, requireMention: true, mapped: false });
    }
    expect(topicRoute({}, GROUP, 40, false)).toMatchObject({ requireMention: false, owner: "daemon", mapped: false });
  });
});

describe("parseTopicMap", () => {
  test("an entry that fails the shape is left out, the rest stay", () => {
    const m = parseTopicMap(
      JSON.stringify({
        [GROUP]: {
          "1": { name: "Ok", owner: "daemon" },
          "0": { name: "Zero thread", owner: "daemon" },
          "2": { name: "", owner: "daemon" },
          "3": { name: "Bad owner", owner: "a b" },
          "4": { name: "Bad flag", owner: "daemon", requireMention: "no" },
          x: { name: "Not a number", owner: "daemon" },
        },
        "123": { "1": { name: "Not a group", owner: "daemon" } },
      }),
    );
    expect(Object.keys(m)).toEqual([GROUP]);
    expect(Object.keys(m[GROUP])).toEqual(["1"]);
  });

  test("not JSON, an array and a number are an empty map", () => {
    expect(parseTopicMap("nope")).toEqual({});
    expect(parseTopicMap("[]")).toEqual({});
    expect(parseTopicMap("5")).toEqual({});
  });
});

describe("makeTopicMapReader (hot reload)", () => {
  test("a missing file is empty, a new file is read, a changed file is read again, a bad file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-map-"));
    const path = join(dir, "topic-map.json");
    const read = makeTopicMapReader(path);
    expect(read()).toEqual({});
    writeFileSync(path, JSON.stringify({ [GROUP]: { "40": { name: "Ops", owner: "daemon" } } }));
    expect(topicRoute(read(), GROUP, 40, true)).toMatchObject({ owner: "daemon", mapped: true });
    writeFileSync(path, JSON.stringify({ [GROUP]: { "40": { name: "Ops", owner: "silent" } } }));
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(topicRoute(read(), GROUP, 40, true)).toEqual({ kind: "drop" });
    writeFileSync(path, "{broken");
    const later2 = new Date(Date.now() + 10000);
    utimesSync(path, later2, later2);
    expect(read()).toEqual({});
  });

  test("a file over the size cap is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-map-big-"));
    const path = join(dir, "topic-map.json");
    writeFileSync(path, ` ${" ".repeat(70 * 1024)}{}`);
    expect(makeTopicMapReader(path)()).toEqual({});
  });
});

describe("outbound thread", () => {
  const threads = new Map<number, number | undefined>([
    [51, 40],
    [52, undefined],
  ]);
  const threadOf = (id: number) => threads.get(id);

  test("a reply carries the thread of the message it answers; an explicit thread wins; General stays General", () => {
    expect(outboundThread(undefined, 51, threadOf)).toBe(40);
    expect(outboundThread(41, 51, threadOf)).toBe(41);
    expect(outboundThread(undefined, 52, threadOf)).toBeUndefined();
    expect(outboundThread(undefined, undefined, threadOf)).toBeUndefined();
    expect(outboundThread(undefined, 99, threadOf)).toBeUndefined();
  });
});

describe("a reply into a silent topic", () => {
  test("topicIsSilent is true only for a silent topic, so a topic made silent mid-answer gets no post", () => {
    expect(topicIsSilent(MAP, GROUP, 25)).toBe(true);
    expect(topicIsSilent(MAP, GROUP, "25")).toBe(true);
    expect(topicIsSilent(MAP, GROUP, 40)).toBe(false);
    expect(topicIsSilent(MAP, GROUP, 999)).toBe(false);
    expect(topicIsSilent(MAP, GROUP, undefined)).toBe(false);
    expect(topicIsSilent({}, GROUP, 25)).toBe(false);
  });

  test("the reply tool refuses before it sends, and only behind the flag", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    const i = server.indexOf("if (topicRouterEnabled()) {\n          thread_id = outboundThread");
    expect(i).toBeGreaterThan(0);
    const block = server.slice(i, i + 900);
    expect(block).toContain("topicIsSilent(readTopicMap(), chat_id, thread_id)");
    expect(block).toContain("throw new Error(");
    // The refusal sits before the allowlist check and before any sendMessage.
    expect(i).toBeLessThan(server.indexOf("assertAllowedChat(chat_id, b);", i));
    expect(server.indexOf("topicIsSilent(readTopicMap()")).toBeLessThan(
      server.indexOf("b.bot.api.sendMessage(chat_id, chunks[i]"),
    );
  });
});

describe("the pre-gate buffer key", () => {
  test("with the router on, topics have their own buffer: a line in a no-mention topic cannot promote another topic's", () => {
    const quiet = pregateKeyOf(GROUP, 41, true);
    const loud = pregateKeyOf(GROUP, 40, true);
    expect(quiet).not.toBe(loud);
    expect(pregateKeyOf(GROUP, 40, true)).toBe(loud);
    expect(pregateKeyOf(GROUP, undefined, true)).toBe(GROUP);
  });

  test("with the router off the key is the chat's, as before", () => {
    expect(pregateKeyOf(GROUP, 40, false)).toBe(GROUP);
    expect(pregateKeyOf(GROUP, 41, false)).toBe(GROUP);
  });

  test("server.ts keys both the buffering and the promotion by it", () => {
    const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(server.split("const key = pregateKey(b, ctx);")).toHaveLength(3);
    expect(server).not.toContain("const key = chatKey(b, String(ctx.chat!.id));\n  const buffered");
  });
});

describe("the flag", () => {
  test("only the exact value on turns the router on", () => {
    expect(topicRouterEnabled({ TELEGRAM_TOPIC_ROUTER: "on" })).toBe(true);
    for (const v of [undefined, "", "ON", "true", "1", "off", " on"])
      expect(topicRouterEnabled({ TELEGRAM_TOPIC_ROUTER: v })).toBe(false);
    expect(topicRouterEnabled({})).toBe(false);
  });
});

describe("server.ts wiring (flag off: unchanged)", () => {
  const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

  test("the gate reads the topic map only behind the flag, after the allowFrom check, and a drop returns before requireMention", () => {
    const gate = server.slice(server.indexOf("function gate(ctx: Context)"), server.indexOf("function isMentioned("));
    const flag = gate.indexOf("if (topicRouterEnabled())");
    expect(flag).toBeGreaterThan(gate.indexOf("groupAllowFrom.includes(senderId)"));
    expect(flag).toBeLessThan(gate.indexOf("if (requireMention && !isMentioned("));
    expect(gate.slice(flag, flag + 500)).toContain('if (tr.kind === "drop") return { action: "drop" };');
  });

  test("a silent topic gets no reply to commands: the check comes before every message:text handler", () => {
    const i = server.indexOf('bot.on("message:text", async (ctx) => {');
    expect(i).toBeGreaterThan(0);
    const block = server.slice(i, i + 700);
    expect(block.indexOf("if (topicSilent(ctx)) return;")).toBeGreaterThan(0);
    expect(block.indexOf("if (topicSilent(ctx)) return;")).toBeLessThan(block.indexOf("handleRouterMessage"));
    expect(server).toContain("if (!topicRouterEnabled() || !ctx.chat || !ctx.message) return false;");
  });

  test("a reply looks the thread up from the in-memory tracker first, then the stored history", () => {
    const i = server.indexOf("function threadOfMessage(");
    expect(i).toBeGreaterThan(0);
    expect(server.slice(i, i + 300)).toContain("messageStore.getThreadId(chatId, msgId, botKey(b))");
  });
});
