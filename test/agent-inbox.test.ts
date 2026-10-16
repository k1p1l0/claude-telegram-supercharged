// bun test test/agent-inbox.test.ts
// Drives agent-inbox.ts with a stubbed notification sink and Telegram send, and
// scripts/agent-msg.sh against it. No bot token, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentInbox, type AgentInboxOptions, resolveInboxDir, startAgentInbox } from "../agent-inbox";

const SCRIPT = join(import.meta.dir, "..", "scripts", "agent-msg.sh");

type Sent = { content: string; meta: Record<string, string> };

let dir: string;
let inbox: AgentInbox | null;
let notified: Sent[];
let mirrored: string[];
let alerts: string[];

function start(extra: Partial<AgentInboxOptions> = {}): AgentInbox {
  inbox = startAgentInbox({
    dir,
    loopLimit: 6,
    notify: (content, meta) => {
      notified.push({ content, meta });
    },
    mirror: async (text) => {
      mirrored.push(text);
    },
    alert: async (text) => {
      alerts.push(text);
    },
    log: () => {},
    scanMs: 60_000, // tests call scan() or rely on fs.watch
    ...extra,
  });
  return inbox;
}

function put(name: string, body: unknown, old = true): string {
  const p = join(dir, "in", name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  // Older than the "still being written" window.
  if (old) utimesSync(p, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
  return p;
}

const ls = (...p: string[]) => (existsSync(join(dir, ...p)) ? readdirSync(join(dir, ...p)).sort() : []);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(25);
  }
}

function run(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", [SCRIPT, ...args], { env: { ...process.env, AGENT_INBOX: dir } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    if (stdin != null) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-inbox-"));
  inbox = null;
  notified = [];
  mirrored = [];
  alerts = [];
});

afterEach(() => {
  inbox?.stop();
});

describe("config", () => {
  test("unset or empty means off; on and ~ expand", () => {
    expect(resolveInboxDir(undefined)).toBeUndefined();
    expect(resolveInboxDir("  ")).toBeUndefined();
    expect(resolveInboxDir("on")).toBe(join(homedir(), "agent-inbox"));
    expect(resolveInboxDir("~/x/in")).toBe(join(homedir(), "x/in"));
    expect(resolveInboxDir("/srv/inbox")).toBe("/srv/inbox");
  });
});

describe("incoming", () => {
  test("valid message is delivered with agent meta, moved to done/, mirrored silently", async () => {
    start();
    put("001.json", { from: "codex@main-mac", text: 'hi "there"\nline 2', reply_to: "a-1-xy" });
    await inbox!.scan();
    expect(notified.length).toBe(1);
    const { content, meta } = notified[0];
    expect(meta.event_type).toBe("agent_message");
    expect(meta.sender_type).toBe("agent");
    expect(meta.from).toBe("codex@main-mac");
    expect(meta.reply_to).toBe("a-1-xy");
    expect(meta.msg_id).toMatch(/^a-\d+-[0-9a-f]{6}$/);
    expect(meta.chat_id).toBeUndefined();
    expect(content).toContain("not the bot owner");
    expect(content).toContain("approval");
    expect(content.endsWith('hi "there"\nline 2')).toBe(true);
    expect(ls("in")).toEqual(["done", "rejected"]);
    expect(ls("in", "done")).toEqual([`${meta.msg_id}.json`]);
    await tick();
    expect(mirrored[0]).toStartWith("🤖 codex@main-mac → Claude");
  });

  test("delivers in file-name order", async () => {
    start();
    put("b.json", { from: "x", text: "second" });
    put("a.json", { from: "x", text: "first" });
    put("c.json", { from: "x", text: "third" });
    await inbox!.scan();
    expect(notified.map((n) => n.content.split("\n").pop())).toEqual(["first", "second", "third"]);
  });

  test("bad files go to rejected/ with an .err note", async () => {
    start();
    put("badfrom.json", { from: "../etc", text: "x" });
    put("empty.json", { from: "pi", text: "   " });
    put("long.json", { from: "pi", text: "x".repeat(8001) });
    put("notjson.json", "{oops");
    put("array.json", "[1,2]");
    put("huge.json", JSON.stringify({ from: "pi", text: "y" }) + " ".repeat(70 * 1024));
    put("badreply.json", { from: "pi", text: "ok", reply_to: "has space" });
    await inbox!.scan();
    expect(notified.length).toBe(0);
    const rej = ls("in", "rejected");
    for (const n of ["badfrom", "empty", "long", "notjson", "array", "huge", "badreply"]) {
      expect(rej).toContain(`${n}.json`);
      expect(rej).toContain(`${n}.json.err`);
    }
    expect(readFileSync(join(dir, "in", "rejected", "long.json.err"), "utf8")).toContain("longer than 8000");
  });

  test("tmp files are ignored, and a fresh unparsable file waits for the next scan", async () => {
    start();
    put("x.json.tmp", { from: "pi", text: "not yet" });
    put("half.json", '{"from":"pi","te', false);
    await inbox!.scan();
    expect(notified.length).toBe(0);
    expect(ls("in")).toEqual(["done", "half.json", "rejected", "x.json.tmp"]);
  });

  test("fs.watch delivers without an explicit scan", async () => {
    start();
    await tick(100);
    put("w.json", { from: "pi@omarchy", text: "watched" });
    await until(() => notified.length === 1);
    expect(notified[0].meta.from).toBe("pi@omarchy");
  });

  test("a failed notification leaves the file in in/ for a retry", async () => {
    let fail = true;
    start({
      notify: (content, meta) => {
        if (fail) throw new Error("transport closed");
        notified.push({ content, meta });
      },
    });
    put("r.json", { from: "pi", text: "retry me" });
    await inbox!.scan();
    expect(ls("in")).toContain("r.json");
    fail = false;
    await inbox!.scan();
    expect(notified.length).toBe(1);
    expect(ls("in")).not.toContain("r.json");
  });

  test("a mirror failure never blocks delivery", async () => {
    start({
      mirror: async () => {
        throw new Error("telegram down");
      },
    });
    put("m.json", { from: "pi", text: "still delivered" });
    await inbox!.scan();
    expect(notified.length).toBe(1);
  });

  test("nothing is delivered while another instance owns the bot", async () => {
    let owner = false;
    start({ canDeliver: () => owner });
    put("o.json", { from: "pi", text: "wait" });
    await inbox!.scan();
    expect(notified.length).toBe(0);
    owner = true;
    await inbox!.scan();
    expect(notified.length).toBe(1);
  });
});

describe("agent_reply", () => {
  test("writes out/<to>/<id>.json atomically and mirrors it", async () => {
    start();
    const r = inbox!.reply({ to: "codex@main-mac", text: 'done\n"ok"', reply_to: "a-1-xy" });
    expect(ls("out", "codex@main-mac")).toEqual([`${r.id}.json`]);
    const rec = JSON.parse(readFileSync(r.path, "utf8"));
    expect(rec).toMatchObject({
      id: r.id,
      from: "claude",
      to: "codex@main-mac",
      text: 'done\n"ok"',
      reply_to: "a-1-xy",
    });
    expect(typeof rec.ts).toBe("string");
    await tick();
    expect(mirrored[0]).toStartWith("🤖 Claude → codex@main-mac");
  });

  test("rejects bad names and empty text", () => {
    start();
    expect(() => inbox!.reply({ to: "../x", text: "hi" })).toThrow();
    expect(() => inbox!.reply({ to: "a/b", text: "hi" })).toThrow();
    expect(() => inbox!.reply({ to: "pi", text: " " })).toThrow();
    expect(ls("out")).toEqual([]);
  });
});

describe("agent-msg.sh", () => {
  test("send escapes JSON; the daemon reads it back exactly", async () => {
    start();
    const text = 'quote " backslash \\ tab \t newline\nunicode ü 🤖 end';
    const r = await run(["send", "codex@main-mac", "-"], text);
    expect(r.code).toBe(0);
    const id = r.out.trim();
    expect(id).toMatch(/^a-\d+-[0-9a-f]+$/);
    await inbox!.scan();
    expect(notified[0].meta.msg_id).toBe(id);
    expect(notified[0].content.endsWith(text)).toBe(true);
  });

  test("ask round-trip: send, Claude answers with agent_reply, the script prints the answer", async () => {
    const answer = 'Answer: "yes"\nsecond line \\ path C:\\tmp\ttab, ü 🤖';
    start({
      notify: (content, meta) => {
        notified.push({ content, meta });
        // Claude answers a moment later.
        setTimeout(() => inbox!.reply({ to: meta.from, text: answer, reply_to: meta.msg_id }), 200);
      },
    });
    // An answer left from an earlier question must not be taken as this one's.
    const stale = inbox!.reply({ to: "codex@main-mac", text: "old answer" });
    const r = await run(["ask", "codex@main-mac", "what now?", "20"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${answer}\n`);
    expect(notified[0].content.endsWith("what now?")).toBe(true);
    const read = ls("out", "codex@main-mac", "read");
    expect(read.length).toBe(1);
    expect(ls("out", "codex@main-mac")).toEqual([`${stale.id}.json`, "read"]);
    // wait on its own takes the leftover one.
    const w = await run(["wait", "codex@main-mac", "5"]);
    expect(w.out).toBe("old answer\n");
  });

  test("wait times out with exit 124; bad names exit 2", async () => {
    const w = await run(["wait", "pi", "1"]);
    expect(w.code).toBe(124);
    const b = await run(["send", "../x", "hi"]);
    expect(b.code).toBe(2);
    expect(ls("in")).toEqual([]);
  });
});

describe("loop guard", () => {
  test("holds the 7th message, posts one notice, releases on a human message", async () => {
    start();
    for (let i = 1; i <= 8; i++) put(`m${i}.json`, { from: "pi", text: `msg ${i}` });
    await inbox!.scan();
    expect(notified.length).toBe(6);
    expect(inbox!.state()).toEqual({ delivered: 6, paused: true });
    await tick();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("paused");
    expect(alerts[0]).toContain("2 more are waiting");
    expect(ls("in")).toEqual(["done", "m7.json", "m8.json", "rejected"]);

    // More scans and new files: still held, no second notice.
    put("m9.json", { from: "pi", text: "msg 9" });
    await inbox!.scan();
    await inbox!.scan();
    expect(notified.length).toBe(6);
    expect(alerts.length).toBe(1);

    inbox!.humanMessage();
    await until(() => notified.length === 9);
    expect(notified.slice(6).map((n) => n.content.split("\n").pop())).toEqual(["msg 7", "msg 8", "msg 9"]);
    expect(inbox!.state()).toEqual({ delivered: 3, paused: false });
  });

  test("a human message resets the count before the limit", async () => {
    start({ loopLimit: 2 });
    put("a.json", { from: "pi", text: "1" });
    put("b.json", { from: "pi", text: "2" });
    await inbox!.scan();
    inbox!.humanMessage();
    put("c.json", { from: "pi", text: "3" });
    put("d.json", { from: "pi", text: "4" });
    await inbox!.scan();
    expect(notified.length).toBe(4);
    expect(alerts.length).toBe(0);
  });

  test("the pause survives a restart", async () => {
    start({ loopLimit: 1 });
    put("a.json", { from: "pi", text: "1" });
    put("b.json", { from: "pi", text: "2" });
    await inbox!.scan();
    expect(notified.length).toBe(1);
    inbox!.stop();
    start({ loopLimit: 1 });
    await inbox!.scan();
    expect(notified.length).toBe(1);
    expect(inbox!.state().paused).toBe(true);
  });
});
