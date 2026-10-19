import { describe, expect, test } from "bun:test";
import {
  NOT_INSTALLED,
  decodeButton,
  encodeButton,
  handleRouterCallback,
  matchOwnerCommand,
  routeOwnerCallback,
  routeOwnerCommand,
  routerPath,
  type HookDeps,
  type RouterModule,
  type RouterResult,
} from "./routerHook";

const calls: { text: string; opts: unknown }[] = [];
const fake = (result: RouterResult | (() => RouterResult)): RouterModule => ({
  routeTelegram: (input, opts) => {
    calls.push({ text: input.text, opts });
    return typeof result === "function" ? result() : result;
  },
});
const deps = (mod: RouterModule | undefined, owners = ["42"]): HookDeps => ({
  loadRouter: async () => mod,
  isOwner: (id) => owners.includes(id),
  accessFile: "/x/access.json",
});
const dm = (text: string, userId = "42", chatType = "private") => ({ text, chatType, chatId: userId, userId, botUsername: "MyBot" });

describe("matchOwnerCommand", () => {
  test("handled commands", () => {
    expect(matchOwnerCommand("/stop 5", "MyBot")).toBe("/stop 5");
    expect(matchOwnerCommand("/STOPALL", "MyBot")).toBe("/stopall");
    expect(matchOwnerCommand("/resume all", "MyBot")).toBe("/resume all");
    expect(matchOwnerCommand("/pause", "MyBot")).toBe("/pause");
    expect(matchOwnerCommand("/stopall@mybot", "MyBot")).toBe("/stopall");
    expect(matchOwnerCommand("/stop   7", "MyBot")).toBe("/stop 7");
  });
  test("/stops maps to the router status text", () => {
    expect(matchOwnerCommand("/stops", "MyBot")).toBe("/status");
    expect(matchOwnerCommand("/stops", "MyBot", "/stops")).toBe("/stops");
  });
  test("not handled", () => {
    for (const t of ["/status", "/stopall@otherbot", "/stopping", "/stoppp 1", "hello /stop", "/pausex", "/stops now", "stop"]) {
      expect(matchOwnerCommand(t, "MyBot")).toBeNull();
    }
  });
});

describe("routeOwnerCommand", () => {
  test("group chats not handled", async () => {
    expect(await routeOwnerCommand(deps(fake({ action: "hold", reply: "x" })), dm("/stop 1", "42", "supergroup"))).toEqual({ handled: false });
  });
  test("non-owner not handled, even with module missing", async () => {
    expect(await routeOwnerCommand(deps(fake({ action: "hold", reply: "x" })), dm("/stop 1", "99"))).toEqual({ handled: false });
    expect(await routeOwnerCommand(deps(undefined), dm("/stop 1", "99"))).toEqual({ handled: false });
  });
  test("owner and module missing: not installed reply", async () => {
    expect(await routeOwnerCommand(deps(undefined), dm("/stop 1"))).toEqual({ handled: true, reply: NOT_INSTALLED });
  });
  test("router bypass (no opt-in): not installed reply", async () => {
    expect(await routeOwnerCommand(deps(fake({ action: "bypass" })), dm("/stopall"))).toEqual({ handled: true, reply: NOT_INSTALLED });
  });
  test("hold reply rendered, access file passed", async () => {
    calls.length = 0;
    const out = await routeOwnerCommand(deps(fake({ action: "hold", reply: "Stop requested for task 3." })), dm("/stop 3"));
    expect(out).toEqual({ handled: true, reply: "Stop requested for task 3." });
    expect(calls[0]).toEqual({ text: "/stop 3", opts: { accessFile: "/x/access.json" } });
  });
  test("router throw is reported, never swallowed", async () => {
    const out = await routeOwnerCommand(deps(fake(() => { throw new Error("db locked"); })), dm("/stop 3"));
    expect(out).toMatchObject({ handled: true });
    expect((out as { reply: string }).reply).toContain("db locked");
  });
  test("buttons become stp: callback_data", async () => {
    const hold: RouterResult = {
      action: "hold",
      reply: "Stop everything?",
      buttons: [
        { label: "Confirm", text: "/stopall confirm 12 3" },
        { label: "Cancel", text: "/stopall cancel 12 3" },
      ],
    };
    const out = await routeOwnerCommand(deps(fake(hold)), dm("/stopall"));
    expect(out).toEqual({
      handled: true,
      reply: "Stop everything?",
      keyboard: [
        { text: "Confirm", callback_data: "stp:c:12:3" },
        { text: "Cancel", callback_data: "stp:x:12:3" },
      ],
    });
  });
  test("an unencodable button stays reachable as text", async () => {
    const out = await routeOwnerCommand(deps(fake({ action: "hold", reply: "R", buttons: [{ label: "Go", text: "/weird 1" }] })), dm("/stopall"));
    expect(out).toEqual({ handled: true, reply: "R\nSend: /weird 1" });
  });
});

describe("callback tokens", () => {
  test("round trip and 64 byte limit with the longest ids", () => {
    for (const verb of ["confirm", "cancel"]) {
      const text = `/stopall ${verb} 999999999 999999999`;
      const data = encodeButton(text)!;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(data.length).toBe(24);
      expect(decodeButton(data)).toBe(text);
    }
    expect(decodeButton("stp:c:1234567890:1")).toBeNull();
    expect(decodeButton("stp:z:1:1")).toBeNull();
    expect(decodeButton("stp:c:1:1:1")).toBeNull();
    expect(encodeButton("/stopall confirm 1")).toBeNull();
    expect(encodeButton("/stop 5")).toBeNull();
  });
});

describe("routeOwnerCallback", () => {
  const cb = (data: string, userId = "42", chatId = userId, chatType = "private") => ({ data, chatType, chatId, userId, botUsername: "MyBot" });
  test("owner tap calls the router with the original command text", async () => {
    calls.length = 0;
    const out = await routeOwnerCallback(deps(fake({ action: "hold", reply: "Stop confirmed." })), cb("stp:c:12:3"));
    expect(out).toEqual({ handled: true, reply: "Stop confirmed." });
    expect(calls[0].text).toBe("/stopall confirm 12 3");
  });
  test("a different user is rejected and the router is not called", async () => {
    calls.length = 0;
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: "ok" })), cb("stp:c:12:3", "99"))).toEqual({ handled: true, reply: "Not authorized." });
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: "ok" })), cb("stp:c:12:3", "42", "-100"))).toEqual({ handled: true, reply: "Not authorized." });
    expect(calls.length).toBe(0);
  });
  test("stale confirm shows the router's rejection text", async () => {
    const stale = "This confirm is old or was used already. Send /stopall again.";
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: stale })), cb("stp:c:12:3"))).toEqual({ handled: true, reply: stale });
  });
  test("garbage token", async () => {
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: "x" })), cb("stp:nope"))).toEqual({ handled: true, reply: "This button is no longer valid." });
  });
  test("module missing: not installed", async () => {
    expect(await routeOwnerCallback(deps(undefined), cb("stp:x:1:1"))).toEqual({ handled: true, reply: NOT_INSTALLED });
  });
});

describe("handleRouterCallback glue", () => {
  test("answers and edits the message without a keyboard", async () => {
    const log: unknown[][] = [];
    const ctx = {
      from: { id: 42 },
      me: { username: "MyBot" },
      callbackQuery: { data: "stp:c:12:3", message: { chat: { id: 42, type: "private" }, message_id: 7 } },
      reply: async () => {},
      answerCallbackQuery: async (...a: unknown[]) => { log.push(["answer", ...a]); },
      editMessageText: async (...a: unknown[]) => { log.push(["edit", ...a]); },
    };
    await handleRouterCallback(ctx, deps(fake({ action: "hold", reply: "Stop confirmed." })));
    expect(log).toEqual([["answer", { text: "Stop confirmed." }], ["edit", "Stop confirmed."]]);
  });
});

describe("routerPath", () => {
  test("env override and default", () => {
    expect(routerPath({ AGENT_HARNESS_ROUTER: "/opt/r.ts" })).toBe("/opt/r.ts");
    expect(routerPath({})).toMatch(/\/Projects\/agent-harness\/telegram-router\.ts$/);
    expect(routerPath({})).not.toContain("~");
  });
});
