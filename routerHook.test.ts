import { describe, expect, test } from "bun:test";
import {
  type HookDeps,
  NOT_INSTALLED,
  type RouterModule,
  type RouterResult,
  decodeButton,
  encodeButton,
  handleRouterCallback,
  isRouterCallbackData,
  matchOwnerCommand,
  routeOwnerCallback,
  routeOwnerCommand,
  routerPath,
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
const dm = (text: string, userId = "42", chatType = "private") => ({
  text,
  chatType,
  chatId: userId,
  userId,
  botUsername: "MyBot",
});

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
    expect(matchOwnerCommand("/stops", "MyBot")).toBe("/stops");
    expect(matchOwnerCommand("/stops", "MyBot", "/custom")).toBe("/custom");
  });
  test("not handled", () => {
    for (const t of [
      "/status",
      "/stopall@otherbot",
      "/stopping",
      "/stoppp 1",
      "hello /stop",
      "/pausex",
      "/stops now",
      "stop",
    ]) {
      expect(matchOwnerCommand(t, "MyBot")).toBeNull();
    }
  });
});

describe("routeOwnerCommand", () => {
  test("group chats not handled", async () => {
    expect(
      await routeOwnerCommand(deps(fake({ action: "hold", reply: "x" })), dm("/stop 1", "42", "supergroup")),
    ).toEqual({ handled: false });
  });
  test("non-owner not handled, even with module missing", async () => {
    expect(await routeOwnerCommand(deps(fake({ action: "hold", reply: "x" })), dm("/stop 1", "99"))).toEqual({
      handled: false,
    });
    expect(await routeOwnerCommand(deps(undefined), dm("/stop 1", "99"))).toEqual({ handled: false });
  });
  test("owner and module missing: not installed reply", async () => {
    expect(await routeOwnerCommand(deps(undefined), dm("/stop 1"))).toEqual({ handled: true, reply: NOT_INSTALLED });
  });
  test("router bypass (no opt-in): not installed reply", async () => {
    expect(await routeOwnerCommand(deps(fake({ action: "bypass" })), dm("/stopall"))).toEqual({
      handled: true,
      reply: NOT_INSTALLED,
    });
  });
  test("hold reply rendered, access file passed", async () => {
    calls.length = 0;
    const out = await routeOwnerCommand(
      deps(fake({ action: "hold", reply: "Stop requested for task 3." })),
      dm("/stop 3"),
    );
    expect(out).toEqual({ handled: true, reply: "Stop requested for task 3." });
    expect(calls[0]).toEqual({ text: "/stop 3", opts: { accessFile: "/x/access.json" } });
  });
  test("router throw is reported, never swallowed", async () => {
    const out = await routeOwnerCommand(
      deps(
        fake(() => {
          throw new Error("db locked");
        }),
      ),
      dm("/stop 3"),
    );
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
    const out = await routeOwnerCommand(
      deps(fake({ action: "hold", reply: "R", buttons: [{ label: "Go", text: "/weird 1" }] })),
      dm("/stopall"),
    );
    expect(out).toEqual({ handled: true, reply: "R\nSend: /weird 1" });
  });
});

describe("callback tokens", () => {
  test("round trip and 64 byte limit with the longest ids", () => {
    for (const verb of ["confirm", "cancel"]) {
      const text = `/stopall ${verb} 999999999 999999999`;
      const data = encodeButton(text)!;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(data.length).toBe(25);
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
  const cb = (data: string, userId = "42", chatId = userId, chatType = "private") => ({
    data,
    chatType,
    chatId,
    userId,
    botUsername: "MyBot",
  });
  test("owner tap calls the router with the original command text", async () => {
    calls.length = 0;
    const out = await routeOwnerCallback(deps(fake({ action: "hold", reply: "Stop confirmed." })), cb("stp:c:12:3"));
    expect(out).toEqual({ handled: true, reply: "Stop confirmed." });
    expect(calls[0].text).toBe("/stopall confirm 12 3");
  });
  test("a different user is rejected and the router is not called", async () => {
    calls.length = 0;
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: "ok" })), cb("stp:c:12:3", "99"))).toEqual({
      handled: true,
      reply: "Not authorized.",
    });
    expect(
      await routeOwnerCallback(deps(fake({ action: "hold", reply: "ok" })), cb("stp:c:12:3", "42", "-100")),
    ).toEqual({ handled: true, reply: "Not authorized." });
    expect(calls.length).toBe(0);
  });
  test("stale confirm shows the router's rejection text", async () => {
    const stale = "This confirm is old or was used already. Send /stopall again.";
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: stale })), cb("stp:c:12:3"))).toEqual({
      handled: true,
      reply: stale,
    });
  });
  test("garbage token", async () => {
    expect(await routeOwnerCallback(deps(fake({ action: "hold", reply: "x" })), cb("stp:nope"))).toEqual({
      handled: true,
      reply: "This button is no longer valid.",
    });
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
      answerCallbackQuery: async (...a: unknown[]) => {
        log.push(["answer", ...a]);
      },
      editMessageText: async (...a: unknown[]) => {
        log.push(["edit", ...a]);
      },
    };
    await handleRouterCallback(ctx, deps(fake({ action: "hold", reply: "Stop confirmed." })));
    expect(log).toEqual([
      ["answer", { text: "Stop confirmed." }],
      ["edit", "Stop confirmed."],
    ]);
  });
});

describe("routerPath", () => {
  test("env override and default", () => {
    expect(routerPath({ AGENT_HARNESS_ROUTER: "/opt/r.ts" })).toBe("/opt/r.ts");
    expect(routerPath({})).toMatch(/\/Projects\/agent-harness\/telegram-router\.ts$/);
    expect(routerPath({})).not.toContain("~");
  });
});

describe("/auto and /goal commands", () => {
  test("matching, with the same @botname rule", () => {
    expect(matchOwnerCommand("/auto", "MyBot")).toBe("/auto");
    expect(matchOwnerCommand("/AUTO  on  4", "MyBot")).toBe("/auto on 4");
    expect(matchOwnerCommand("/auto@mybot status", "MyBot")).toBe("/auto status");
    expect(matchOwnerCommand("/auto undo 7", "MyBot")).toBe("/auto undo 7");
    expect(matchOwnerCommand("/auto confirm 3", "MyBot")).toBe("/auto confirm 3");
    expect(matchOwnerCommand("/goals", "MyBot")).toBe("/goals");
    expect(matchOwnerCommand("/goal 5", "MyBot")).toBe("/goal 5");
    expect(matchOwnerCommand("/goal done 5", "MyBot")).toBe("/goal done 5");
    expect(matchOwnerCommand("/goal@MyBot new Ship it | 2026-11-01 | a; b", "MyBot")).toBe(
      "/goal new Ship it | 2026-11-01 | a; b",
    );
  });
  test("not matched", () => {
    for (const t of ["/auto@otherbot on", "/goal@otherbot 1", "/autopilot", "/goalie", "/goalsx", "/automate on", "auto on"]) {
      expect(matchOwnerCommand(t, "MyBot")).toBeNull();
    }
  });
  test("plugin commands stay untouched", () => {
    for (const t of ["/status", "/agents", "/help", "/start"]) expect(matchOwnerCommand(t, "MyBot")).toBeNull();
  });
  test("non-owner and group are not handled", async () => {
    const d = deps(fake({ action: "hold", reply: "x" }));
    expect(await routeOwnerCommand(d, dm("/auto on", "99"))).toEqual({ handled: false });
    expect(await routeOwnerCommand(d, dm("/goal new x", "42", "supergroup"))).toEqual({ handled: false });
  });
  test("owner text reaches the router and buttons become aut:/gol: tokens", async () => {
    calls.length = 0;
    const out = await routeOwnerCommand(
      deps(
        fake({
          action: "hold",
          reply: "Turn on?",
          buttons: [
            { label: "Confirm", text: "/auto confirm 4" },
            { label: "Cancel", text: "/auto cancel 4" },
          ],
        }),
      ),
      dm("/auto on 2"),
    );
    expect(calls[0].text).toBe("/auto on 2");
    expect(out).toEqual({
      handled: true,
      reply: "Turn on?",
      keyboard: [
        { text: "Confirm", callback_data: "aut:c:4" },
        { text: "Cancel", callback_data: "aut:x:4" },
      ],
    });
    const g = await routeOwnerCommand(
      deps(fake({ action: "hold", reply: "New goal", buttons: [{ label: "Confirm", text: "/goal confirm 9" }] })),
      dm("/goal new A | B | C"),
    );
    expect(g).toMatchObject({ keyboard: [{ callback_data: "gol:c:9" }] });
  });
});

describe("aut: and gol: callback tokens", () => {
  const texts = [
    "/auto confirm 999999999",
    "/auto cancel 999999999",
    "/auto undo 999999999",
    "/auto stop",
    "/goal confirm 999999999",
    "/goal cancel 999999999",
    "/goal stop 999999999",
  ];
  test("round trip and 64 byte limit", () => {
    for (const t of texts) {
      const data = encodeButton(t)!;
      expect(data).not.toBeNull();
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(decodeButton(data)).toBe(t);
    }
    expect(encodeButton("/auto confirm 1")).toBe("aut:c:1");
    expect(encodeButton("/auto undo 12")).toBe("aut:u:12");
    expect(encodeButton("/goal cancel 3")).toBe("gol:x:3");
    expect(encodeButton("/stopall confirm 12 3")).toBe("stp:c:12:3");
  });
  test("malformed tokens and unknown forms are refused", () => {
    for (const d of ["aut:c", "aut:c:1234567890", "aut:z:1", "aut:s:1", "aut:", "gol:u:1", "gol:c:", "gol:c:1:2", "gol:s"]) {
      expect(decodeButton(d)).toBeNull();
    }
    expect(encodeButton("/auto on 2")).toBeNull();
    expect(encodeButton("/auto stop 3")).toBeNull();
    expect(encodeButton("/goal done 3")).toBeNull();
    expect(encodeButton("/goal new x")).toBeNull();
  });
  test("owner tap runs the router; non-owner and groups are rejected before it", async () => {
    calls.length = 0;
    const cb = (data: string, userId = "42", chatId = userId, chatType = "private") => ({
      data,
      chatType,
      chatId,
      userId,
      botUsername: "MyBot",
    });
    const d = deps(fake({ action: "hold", reply: "ok" }));
    expect(await routeOwnerCallback(d, cb("aut:u:7"))).toEqual({ handled: true, reply: "ok" });
    expect(calls[0].text).toBe("/auto undo 7");
    expect(await routeOwnerCallback(d, cb("gol:s:2"))).toEqual({ handled: true, reply: "ok" });
    expect(calls[1].text).toBe("/goal stop 2");
    expect(await routeOwnerCallback(d, cb("aut:c:1", "99"))).toEqual({ handled: true, reply: "Not authorized." });
    expect(await routeOwnerCallback(d, cb("gol:c:1", "42", "-100", "supergroup"))).toEqual({
      handled: true,
      reply: "Not authorized.",
    });
    expect(calls.length).toBe(2);
  });
  test("a stale tap shows the router's rejection", async () => {
    const stale = "This confirm is old or was used already. Send /auto on again.";
    const out = await routeOwnerCallback(deps(fake({ action: "hold", reply: stale })), {
      data: "aut:c:3",
      chatType: "private",
      chatId: "42",
      userId: "42",
      botUsername: "MyBot",
    });
    expect(out).toEqual({ handled: true, reply: stale });
  });
  test("isRouterCallbackData covers the three prefixes only", () => {
    expect(["stp:c:1:1", "aut:s", "gol:c:1"].every(isRouterCallbackData)).toBe(true);
    expect(["perm:allow:x", "dec:1", "auto:1"].some(isRouterCallbackData)).toBe(false);
  });
});
