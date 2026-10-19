import { Database } from "bun:sqlite";
// bun test needsList.test.ts
// The "Needs you" list and its answer route. No bot, no network, no real state: temp folders and sqlite files.
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDecisionTap, tapRowText } from "./decisionTap";
import { needsRoute, telegramUserOf } from "./miniapp";
import {
  type NeedsApproval,
  type NeedsDeps,
  type Source,
  buildDecisions,
  clipText,
  createNeeds,
  lockedRead,
  notAnswerable,
  parseState,
  readApprovalsDb,
  redact,
} from "./needsList";

const dir = mkdtempSync(join(tmpdir(), "needs-list-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const OWNER = "305120844";
const NOW = Date.parse("2026-10-19T12:00:00Z");

// ── fixtures ──
const dec = (over: Record<string, unknown> = {}) => ({
  project: "p1",
  code: "D1",
  options: { a: "Approve", b: "Reject", later: "Later" },
  text: "D1 · Title line\n\nBody text",
  version: 1,
  shown: 1,
  msgs: [500],
  msg: 500,
  queued_at: "2026-10-19T11:00:00Z",
  sent_at: "2026-10-19T11:00:01Z",
  answered: null,
  kind: "inline",
  ...over,
});
const stateJson = (decisions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ live: null, queue: [], decisions, ...extra });

const SCHEMA = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, chat_id TEXT NOT NULL, user_id TEXT,
  username TEXT, first_name TEXT, text TEXT, media_type TEXT, caption TEXT, reply_to_msg_id INTEGER,
  date INTEGER NOT NULL, edit_date INTEGER, is_outgoing INTEGER DEFAULT 0, thread_id INTEGER,
  bot TEXT NOT NULL DEFAULT '', UNIQUE(chat_id, message_id, bot))`;
const n = 0;
function memStore() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return {
    db,
    store(m: any) {
      db.run(
        "INSERT OR REPLACE INTO messages (message_id, chat_id, user_id, username, first_name, text, reply_to_msg_id, date, is_outgoing, bot) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          m.message_id,
          m.chat_id,
          m.user_id ?? null,
          m.username ?? null,
          m.first_name ?? null,
          m.text ?? null,
          m.reply_to_msg_id ?? null,
          m.date,
          m.is_outgoing ? 1 : 0,
          m.bot ?? "",
        ],
      );
    },
    taps(chatId: string, replyTo: number, bot: string): string[] {
      return (
        db
          .query(
            "SELECT text FROM messages WHERE chat_id = ? AND bot = ? AND reply_to_msg_id = ? AND message_id < 0 AND is_outgoing = 0",
          )
          .all(chatId, bot, replyTo) as Array<{ text: string }>
      ).map((r) => r.text);
    },
    rows: () => db.query("SELECT * FROM messages ORDER BY id").all() as Array<Record<string, any>>,
  };
}

function harness(stateText: string | null | Error, approvals?: Source<NeedsApproval>, cardChat?: () => string | null) {
  const store = memStore();
  const edits: Array<[string, number, string]> = [];
  let reads = 0;
  let clock = NOW;
  let editFails = false;
  let current = stateText;
  const deps: NeedsDeps = {
    readState: async () => {
      reads++;
      if (current instanceof Error) throw current;
      return current;
    },
    readApprovals: () => approvals ?? { status: "ok", items: [] },
    store,
    editCard: async (c, m, t) => {
      if (editFails) throw new Error("telegram down");
      edits.push([c, m, t]);
    },
    bot: "",
    cardChat: cardChat ?? (() => OWNER),
    now: () => clock,
    log: () => {},
  };
  return {
    needs: createNeeds(deps),
    store,
    edits,
    reads: () => reads,
    tick: (ms: number) => {
      clock += ms;
    },
    setState: (s: string | null | Error) => {
      current = s;
    },
    breakEdits: () => {
      editFails = true;
    },
  };
}

// ── initData: bad signature, expired, not allowlisted ──
const TOKEN = "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN";
function signed(user: string, authDate: number, token = TOKEN, tamper = false) {
  const p = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "q",
    user: JSON.stringify({ id: Number(user) }),
  });
  const check = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  if (tamper) p.set("query_id", "other");
  return p.toString();
}
const req = (path: string, init: RequestInit & { auth?: string } = {}) =>
  new Request(`http://x${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.auth ? { authorization: `tma ${init.auth}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body,
  });

describe("needsRoute: initData and allowlist", () => {
  const h = harness(stateJson({ "p1/D1": dec() }));
  const user = telegramUserOf(TOKEN, (id) => id === OWNER);
  const call = (path: string, init: RequestInit & { auth?: string } = {}) =>
    needsRoute(
      req(path, init),
      path,
      user,
      h.needs,
      () => {},
      () => true,
      user,
    );
  const fresh = Math.floor(Date.now() / 1000);

  test("not a needs path is null", async () => {
    expect(await call("/api/state")).toBeNull();
  });
  test("no header, bad signature, wrong token, expired, not allowlisted: 401", async () => {
    for (const auth of [
      undefined,
      signed(OWNER, fresh, TOKEN, true),
      signed(OWNER, fresh, "999:OTHER_TOKEN_OTHER_TOKEN_OTHER_TOKEN"),
      signed(OWNER, fresh - 90_000),
      signed("42", fresh),
    ]) {
      expect((await call("/api/needs", { auth }))!.status).toBe(401);
      expect((await call("/api/needs/answer", { method: "POST", auth, body: "{}" }))!.status).toBe(401);
    }
  });
  test("a good initData reads the list", async () => {
    const r = (await call("/api/needs", { auth: signed(OWNER, fresh) }))!;
    expect(r.status).toBe(200);
    expect((await r.json()).decisions.items[0].code).toBe("D1");
  });
  test("wrong method is 405, a missing needs backend is 404", async () => {
    expect((await call("/api/needs", { method: "POST", auth: signed(OWNER, fresh), body: "{}" }))!.status).toBe(405);
    expect((await call("/api/needs/answer", { auth: signed(OWNER, fresh) }))!.status).toBe(405);
    const r = await needsRoute(
      req("/api/needs", { auth: signed(OWNER, fresh) }),
      "/api/needs",
      user,
      undefined,
      () => {},
      () => true,
      user,
    );
    expect(r!.status).toBe(404);
  });
  test("answer body must be JSON", async () => {
    const r = await call("/api/needs/answer", { method: "POST", auth: signed(OWNER, fresh), body: "nope" });
    expect(r!.status).toBe(400);
  });
  test("the log line never carries initData", async () => {
    const lines: string[] = [];
    const auth = signed(OWNER, fresh);
    await needsRoute(
      req("/api/needs/answer", { method: "POST", auth, body: JSON.stringify({ code: "D1", version: 1, option: "a" }) }),
      "/api/needs/answer",
      user,
      h.needs,
      (m) => lines.push(m),
      () => true,
      user,
    );
    expect(lines.length).toBe(2); // the result line and the accepted-answer line
    expect(lines.join("")).not.toContain(auth);
    expect(lines.join("")).not.toContain("hash=");
  });
  test("a successful answer logs one surface=miniapp line, a rejected one does not", async () => {
    const hh = harness(stateJson({ "p1/D1": dec() }));
    const lines: string[] = [];
    const auth = signed(OWNER, fresh);
    const post = (body: unknown) =>
      needsRoute(
        req("/api/needs/answer", { method: "POST", auth, body: JSON.stringify(body) }),
        "/api/needs/answer",
        user,
        hh.needs,
        (m) => lines.push(m),
        () => true,
        user,
      );
    const bad = await post({ project: "p1", code: "D1", version: 1, option: "nope" });
    expect(bad!.status).not.toBe(200);
    expect(lines.filter((l) => l.includes("surface=miniapp"))).toEqual([]);
    const good = await post({ project: "p1", code: "D1", version: 1, option: "a" });
    expect(good!.status).toBe(200);
    const mine = lines.filter((l) => l.includes("surface=miniapp"));
    expect(mine).toEqual(["mini app: needs answer surface=miniapp code=D1 version=1 option=a"]);
    expect(mine[0]).not.toContain(auth);
    expect(mine[0]).not.toContain("hash=");
    expect(mine[0]).not.toContain(TOKEN);
    expect(mine[0]).not.toContain(OWNER);
  });
});

describe("answer: owner chat, freshness, strict shown (review of PR 57)", () => {
  const body = { project: "p1", code: "D1", version: 1, option: "a" };
  const OTHER = "222";

  test("B2: only the user of the card chat can answer; nothing is written for anyone else", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }), undefined, () => OWNER);
    const [status, reply] = await h.needs.answer(OTHER, body);
    expect(status).toBe(403);
    expect(reply.reason).toBe("not_owner");
    expect(h.store.rows()).toHaveLength(0);
    expect(h.edits).toEqual([]);
    const [ok] = await h.needs.answer(OWNER, body);
    expect(ok).toBe(200);
    expect(h.edits).toEqual([[OWNER, 500, "✅ Approve"]]);
  });

  test("B2: no known card chat means no answer", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }), undefined, () => null);
    expect((await h.needs.answer(OWNER, body))[0]).toBe(403);
    expect(h.store.rows()).toHaveLength(0);
  });

  test("I3: a decision with shown missing or 0 is not answerable, like verdict() in the skill", async () => {
    for (const shown of [undefined, 0, 2]) {
      const h = harness(stateJson({ "p1/D1": dec({ shown }) }));
      const [status, reply] = await h.needs.answer(OWNER, body);
      expect(status).toBe(409);
      expect(reply.reason).toBe("not_answerable");
    }
  });

  test("L3: a non-string queued_at or answered.at in one entry does not blank the list", async () => {
    const h = harness(
      stateJson({
        "p1/D1": dec({ queued_at: 12345 }),
        "p1/D2": dec({ code: "D2", queued_at: "2026-10-19T12:00:00Z", msg: 501 }),
      }),
    );
    const r = (await h.needs.list()) as any;
    expect(r.decisions.status).toBe("ok");
    expect(r.decisions.items).toHaveLength(2);
  });
});

describe("needsRoute: owner only and fresh initData for answers (review of PR 57)", () => {
  const h = harness(stateJson({ "p1/D1": dec() }));
  const everyone = telegramUserOf(TOKEN, () => true);
  const fresh10 = telegramUserOf(TOKEN, () => true, 3600);
  const now = Math.floor(Date.now() / 1000);
  const call = (path: string, init: RequestInit & { auth?: string }, canSee: (u: string) => boolean = () => true) =>
    needsRoute(req(path, init), path, everyone, h.needs, () => {}, canSee, fresh10);

  test("I1: a user that is not owner or admin gets 403 on the list and on the answer", async () => {
    const auth = signed("222", now);
    expect((await call("/api/needs", { auth }, (u) => u === OWNER))!.status).toBe(403);
    const r = await call("/api/needs/answer", { method: "POST", auth, body: "{}" }, (u) => u === OWNER);
    expect(r!.status).toBe(403);
  });

  test("I2: the list accepts a day-old initData, the answer needs one younger than an hour and says to reopen", async () => {
    const old = signed(OWNER, now - 7200);
    expect((await call("/api/needs", { auth: old }))!.status).toBe(200);
    const r = await call("/api/needs/answer", { method: "POST", auth: old, body: "{}" });
    expect(r!.status).toBe(401);
    expect(((await r!.json()) as any).reason).toBe("stale_session");
    // An hour-old session still answers (the app stays open between decisions).
    const mid = await call("/api/needs/answer", {
      method: "POST",
      auth: signed(OWNER, now - 1800),
      body: JSON.stringify({ project: "p1", code: "D1", version: 1, option: "a" }),
    });
    expect(mid!.status).toBe(200);
  });

  test("L1: a code with newlines or control characters is cleaned before it is logged", async () => {
    const lines: string[] = [];
    await needsRoute(
      req("/api/needs/answer", {
        method: "POST",
        auth: signed(OWNER, now),
        body: JSON.stringify({ code: "D1\nforged line", version: 1, option: "a" }),
      }),
      "/api/needs/answer",
      everyone,
      h.needs,
      (m) => lines.push(m),
      () => true,
      fresh10,
    );
    expect(lines.join("")).not.toContain("\n");
  });
});

describe("buildDecisions", () => {
  test("live first, then the old queue, then inline oldest first; answered ones are left out", () => {
    const st = parseState(
      stateJson(
        {
          "p/old1": dec({ project: "p", code: "old1", kind: undefined, msg: 0 }),
          "p/old2": dec({ project: "p", code: "old2", kind: undefined, msg: 0 }),
          "p/i-new": dec({ project: "p", code: "i-new", queued_at: "2026-10-19T11:30:00Z" }),
          "p/i-old": dec({ project: "p", code: "i-old", queued_at: "2026-10-19T10:00:00Z" }),
          "p/done": dec({
            project: "p",
            code: "done",
            answered: { option: "a", label: "Approve", at: "x", version: 1 },
          }),
        },
        { live: "p/old2", queue: ["p/old1", "p/old2"] },
      ),
    );
    const out = buildDecisions(st, NOW);
    expect(out.map((d) => d.code)).toEqual(["old2", "old1", "i-old", "i-new"]);
    expect(out[0].live).toBe(true);
    expect(out[1].live).toBe(false);
  });
  test("options keep the card's order and carry Later; fields are filled", () => {
    const [d] = buildDecisions(parseState(stateJson({ "p1/D1": dec() })), NOW);
    expect(d.options).toEqual([
      { key: "a", label: "Approve" },
      { key: "b", label: "Reject" },
      { key: "later", label: "Later" },
    ]);
    expect(d).toMatchObject({
      source: "decision",
      project: "p1",
      code: "D1",
      title: "D1 · Title line",
      version: 1,
      answerable: true,
      age_s: 3600,
    });
  });
  test("old reply-keyboard decisions are listed but not answerable", () => {
    const [d] = buildDecisions(
      parseState(stateJson({ "p/o": dec({ kind: undefined }) }, { live: "p/o", queue: ["p/o"] })),
      NOW,
    );
    expect(d.answerable).toBe(false);
    expect(d.reason).toContain("Telegram");
  });
  test("text is redacted and clipped", () => {
    const secret = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const [d] = buildDecisions(
      parseState(stateJson({ "p1/D1": dec({ text: `Title\ntoken ${secret} ${"x".repeat(3000)}` }) })),
      NOW,
    );
    expect(d.text).not.toContain(secret);
    expect(d.text).toContain("[redacted]");
    expect(d.text.length).toBeLessThanOrEqual(1500);
    expect(redact("Bearer abcdefghijklmnop1234")).toBe("[redacted]");
    expect(clipText("a".repeat(10), 5)).toBe("aaaa…");
  });
});

describe("notAnswerable (ported from tg_decisions.py)", () => {
  test("cases", () => {
    expect(notAnswerable(dec() as any)).toBeNull();
    expect(notAnswerable(dec({ answered: { option: "a" } }) as any)).toBe("closed");
    expect(notAnswerable(dec({ kind: undefined }) as any)).toContain("old reply-keyboard");
    expect(notAnswerable(dec({ msg: 0 }) as any)).toContain("not sent");
    expect(notAnswerable(dec({ version: 2, shown: 1 }) as any)).toContain("older version");
  });
});

describe("list: sources and their status", () => {
  test("all ok, inbox not wired", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }), {
      status: "ok",
      items: [
        {
          source: "approval",
          id: 1,
          task_id: 3,
          title: "t",
          text: "x",
          requested_by: "pi",
          requested_at: "2026-10-19T11:00:00Z",
          age_s: 60,
        },
      ],
    });
    const r = await h.needs.list();
    expect(r.decisions.status).toBe("ok");
    expect(r.approvals.items).toHaveLength(1);
    expect(r.inbox).toMatchObject({ status: "not wired", items: [] });
  });
  test("empty state is ok with no items, not an error", async () => {
    for (const s of [null, stateJson({})]) {
      const r = await harness(s).needs.list();
      expect(r.decisions).toEqual({ status: "ok", items: [] });
    }
  });
  test("unreadable lock and broken json are errors, not an empty list", async () => {
    const a = await harness(new Error("state.json read failed: timed out on the lock")).needs.list();
    expect(a.decisions.status).toBe("error");
    expect(a.decisions.items).toEqual([]);
    expect(a.decisions.error).toContain("timed out");
    const b = await harness("{ half written").needs.list();
    expect(b.decisions.status).toBe("error");
    const c = await harness('{"no":"decisions"}').needs.list();
    expect(c.decisions.status).toBe("error");
  });
  test("a throwing approvals source reports its own error and leaves the decisions alone", async () => {
    const store = memStore();
    const needs = createNeeds({
      readState: async () => stateJson({ "p1/D1": dec() }),
      readApprovals: () => {
        throw new Error("db locked");
      },
      store,
      editCard: async () => {},
      bot: "",
      now: () => NOW,
    });
    const r = await needs.list();
    expect(r.approvals).toMatchObject({ status: "error" });
    expect(r.decisions.status).toBe("ok");
  });
  test("the result is cached for under 2 s only", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    await h.needs.list();
    await h.needs.list();
    expect(h.reads()).toBe(1);
    h.tick(1999);
    await h.needs.list();
    expect(h.reads()).toBe(1);
    h.tick(2);
    await h.needs.list();
    expect(h.reads()).toBe(2);
  });
  test("one 'needs list codes=' line when the set of codes changes, in the log and in needs-answers.log", async () => {
    const lines: string[] = [];
    const file = join(dir, "needs-answers.log");
    let clock = NOW;
    let current = stateJson({ "p1/D2": dec({ code: "D2" }), "p1/D1": dec() });
    const needs = createNeeds({
      readState: async () => current,
      readApprovals: () => ({ status: "ok", items: [] }),
      store: memStore(),
      editCard: async () => {},
      bot: "",
      now: () => clock,
      log: (m) => lines.push(m),
      answersLog: file,
    });
    const codeLines = () => lines.filter((l) => l.startsWith("mini app: needs list codes="));
    await needs.list();
    expect(codeLines()).toEqual(["mini app: needs list codes=D1,D2"]);
    clock += 3000;
    await needs.list(); // same set: no second line
    expect(codeLines()).toHaveLength(1);
    current = stateJson({ "p1/D2": dec({ code: "D2" }), "p1/D1": dec({ answered: { option: "a", version: 1 } }) });
    clock += 3000;
    await needs.list(); // D1 answered elsewhere: the set changed
    expect(codeLines()).toEqual(["mini app: needs list codes=D1,D2", "mini app: needs list codes=D2"]);
    current = new Error("lock busy") as unknown as string;
    clock += 3000;
    await needs.list(); // an unreadable state is not a change of the set
    expect(codeLines()).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe(
      "2026-10-19T12:00:00.000Z mini app: needs list codes=D1,D2\n2026-10-19T12:00:06.000Z mini app: needs list codes=D2\n",
    );
  });
});

describe("approvals from tasks.db (read-only)", () => {
  const dbPath = join(dir, "tasks.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE approvals (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL, requested_at TEXT NOT NULL);
    INSERT INTO tasks VALUES (3, 'Remove HOLD'), (6, 'Relocate');
    INSERT INTO approvals VALUES (1, 3, 'Do the thing', 'pending', 'pi@main-mac', '2026-10-19T11:00:00Z'),
      (2, 6, 'Old', 'approved', 'pi@main-mac', '2026-10-17T11:00:00Z');`);
  db.close();
  test("only pending approvals, with the task title", () => {
    const r = readApprovalsDb(dbPath, NOW);
    expect(r.status).toBe("ok");
    expect(r.items).toEqual([
      {
        source: "approval",
        id: 1,
        task_id: 3,
        title: "Remove HOLD",
        text: "Do the thing",
        requested_by: "pi@main-mac",
        requested_at: "2026-10-19T11:00:00Z",
        age_s: 3600,
      },
    ]);
  });
  test("a missing db is not wired, a broken one is an error", () => {
    expect(readApprovalsDb(join(dir, "none.db"), NOW).status).toBe("not wired");
    writeFileSync(join(dir, "bad.db"), "this is not sqlite at all, just text padding".repeat(5));
    expect(readApprovalsDb(join(dir, "bad.db"), NOW).status).toBe("error");
  });
  test("the connection cannot write", () => {
    const ro = new Database(dbPath, { readonly: true });
    expect(() => ro.exec("DELETE FROM approvals")).toThrow();
    ro.close();
  });
});

describe("lockedRead: shared lock, no retry loop", () => {
  const state = join(dir, "state.json");
  const lock = join(dir, ".state.lock");
  writeFileSync(state, '{"decisions":{}}');
  writeFileSync(lock, "");
  test("reads the file through the helper", async () => {
    expect(await lockedRead(state, lock, 4000)).toBe('{"decisions":{}}');
  });
  test("a missing file is null", async () => {
    expect(await lockedRead(join(dir, "nope.json"), lock, 4000)).toBeNull();
  });
  test("the helper is called once with a timeout", async () => {
    const calls: any[] = [];
    const run: any = (cmd: string, args: string[], opts: any, cb: any) => {
      calls.push({ cmd, args, opts });
      cb(null, "{}");
    };
    expect(await lockedRead(state, lock, 1500, run)).toBe("{}");
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.timeout).toBe(1500);
    expect(calls[0].args.join(" ")).toContain(lock);
  });
  test("an exclusive writer makes the read fail by timeout instead of reading", async () => {
    const holder = Bun.spawn(
      [
        "python3",
        "-I",
        "-c",
        "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(4)",
        lock,
      ],
      { stdout: "pipe" },
    );
    try {
      await holder.stdout.getReader().read(); // "held"
      const t0 = Date.now();
      await expect(lockedRead(state, lock, 600)).rejects.toThrow(/timed out/);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });
  test("createNeeds reads state through the injected locked reader on list and on answer", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    await h.needs.list();
    expect(h.reads()).toBe(1);
    await h.needs.answer(OWNER, { code: "D1", version: 1, option: "a" });
    expect(h.reads()).toBe(2);
  });
});

describe("answer", () => {
  const body = (o: Record<string, unknown> = {}) => ({ project: "p1", code: "D1", version: 1, option: "a", ...o });

  test("accepts: one row, the card gets the inert button", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    const [status, reply] = await h.needs.answer(OWNER, body());
    expect(status).toBe(200);
    expect(reply).toMatchObject({
      ok: true,
      already: false,
      answer: { code: "D1", version: 1, option: "a", label: "Approve" },
    });
    const rows = h.store.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      text: "D1 Approve",
      reply_to_msg_id: 500,
      chat_id: OWNER,
      user_id: OWNER,
      is_outgoing: 0,
      bot: "",
    });
    expect(rows[0].message_id).toBeLessThan(0);
    expect(h.edits).toEqual([[OWNER, 500, "✅ Approve"]]);
  });

  test("the row equals what the shared helper writes for a Telegram tap", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    await h.needs.answer(OWNER, body());
    const tg = memStore();
    recordDecisionTap(tg, {
      tapId: "4382910475920183",
      nowMs: NOW,
      chatId: OWNER,
      userId: OWNER,
      code: "D1",
      key: "a",
      label: "Approve",
      decisionMsgId: 500,
      bot: "",
    });
    const strip = ({ id, message_id, date, ...rest }: Record<string, any>) => rest;
    expect(strip(h.store.rows()[0])).toEqual(strip(tg.rows()[0]));
    expect(h.store.rows()[0].text).toBe(tapRowText("D1", "Approve"));
  });

  test("a second tap returns the first answer and writes no second row", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    await h.needs.answer(OWNER, body());
    const [status, reply] = await h.needs.answer(OWNER, body({ option: "b" }));
    expect(status).toBe(200);
    expect(reply).toMatchObject({ ok: true, already: true, answer: { option: "a", label: "Approve" } });
    expect(h.store.rows()).toHaveLength(1);
    expect(h.edits).toHaveLength(1);
  });

  test("two taps at the same time still write one row", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    const [x, y] = await Promise.all([h.needs.answer(OWNER, body()), h.needs.answer(OWNER, body({ option: "b" }))]);
    expect([x[0], y[0]]).toEqual([200, 200]);
    expect(h.store.rows()).toHaveLength(1);
  });

  test("after the watch closed it, the same version returns its answer; another version is refused", async () => {
    const answered = { option: "b", label: "Reject", at: "2026-10-19T11:05:00Z", version: 1 };
    const h = harness(stateJson({ "p1/D1": dec({ answered }) }));
    const [s1, r1] = await h.needs.answer(OWNER, body());
    expect(s1).toBe(200);
    expect(r1).toMatchObject({ already: true, answer: { option: "b", label: "Reject" } });
    const [s2, r2] = await h.needs.answer(OWNER, body({ version: 2 }));
    expect([s2, r2.reason]).toEqual([409, "closed"]);
    expect(h.store.rows()).toHaveLength(0);
  });

  test("closed by `close` (no option) is rejected", async () => {
    const h = harness(
      stateJson({ "p1/D1": dec({ answered: { option: null, label: null, at: "x", by: "close", version: 1 } }) }),
    );
    const [s, r] = await h.needs.answer(OWNER, body());
    expect([s, r.reason]).toEqual([409, "closed"]);
  });

  test("stale version: 409 with the current version", async () => {
    const h = harness(stateJson({ "p1/D1": dec({ version: 3, shown: 3 }) }));
    const [s, r] = await h.needs.answer(OWNER, body({ version: 2 }));
    expect([s, r.reason, r.version]).toEqual([409, "stale", 3]);
    expect(h.store.rows()).toHaveLength(0);
  });

  test("unknown option: 400", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    const [s, r] = await h.needs.answer(OWNER, body({ option: "zzz" }));
    expect([s, r.reason]).toEqual([400, "unknown_option"]);
    expect(h.store.rows()).toHaveLength(0);
  });

  test("unknown decision: 404; malformed input: 400", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    expect((await h.needs.answer(OWNER, body({ code: "NOPE" })))[0]).toBe(404);
    for (const bad of [
      { code: "" },
      { code: "a b" },
      { option: "" },
      { version: 0 },
      { version: "x" },
      { version: 1.5 },
    ])
      expect((await h.needs.answer(OWNER, body(bad)))[0]).toBe(400);
  });

  test("verdict rules: card version differs from the text, old queue, unsent card", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ version: 2, shown: 1 }, "not_answerable"],
      [{ kind: undefined }, "not_answerable"],
      [{ msg: 0 }, "not_answerable"],
    ];
    for (const [over, reason] of cases) {
      const h = harness(stateJson({ "p1/D1": dec(over) }));
      const [s, r] = await h.needs.answer(OWNER, body({ version: Number(over.version ?? 1) }));
      expect([s, r.reason]).toEqual([409, reason]);
      expect(h.store.rows()).toHaveLength(0);
    }
  });

  test("a newer version of the same code in the project refuses the old tap", async () => {
    const h = harness(stateJson({ "p1/D1": dec({ version: 2, shown: 2, msg: 600, msgs: [500, 600] }) }));
    const [s, r] = await h.needs.answer(OWNER, body({ version: 1 }));
    expect([s, r.reason]).toEqual([409, "stale"]);
  });

  test("the same code in two projects needs the project", async () => {
    const h = harness(stateJson({ "p1/D1": dec(), "p2/D1": dec({ project: "p2", msg: 700 }) }));
    const [s, r] = await h.needs.answer(OWNER, { code: "D1", version: 1, option: "a" });
    expect([s, r.reason]).toEqual([400, "ambiguous"]);
    const [s2] = await h.needs.answer(OWNER, body({ project: "p2" }));
    expect(s2).toBe(200);
    expect(h.store.rows()[0].reply_to_msg_id).toBe(700);
  });

  test("Later writes the row like Telegram, does not touch the card, and keeps the decision open", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    const [s, r] = await h.needs.answer(OWNER, body({ option: "later" }));
    expect([s, r.later]).toEqual([200, true]);
    expect(h.store.rows()[0].text).toBe("D1 Later");
    expect(h.edits).toHaveLength(0);
    // a real answer afterwards still goes through
    const [s2, r2] = await h.needs.answer(OWNER, body());
    expect([s2, r2.already]).toEqual([200, false]);
  });

  test("a failing card edit still records the answer and says so", async () => {
    const h = harness(stateJson({ "p1/D1": dec() }));
    h.breakEdits();
    const [s, r] = await h.needs.answer(OWNER, body());
    expect([s, r.card_updated]).toEqual([200, false]);
    expect(h.store.rows()).toHaveLength(1);
  });

  test("an unreadable state refuses with 503 and writes nothing", async () => {
    const h = harness(new Error("timed out on the lock"));
    const [s, r] = await h.needs.answer(OWNER, body());
    expect([s, r.reason]).toEqual([503, "state_unreadable"]);
    expect(h.store.rows()).toHaveLength(0);
  });
});

describe("miniapp/index.html", () => {
  const html = Bun.file(join(import.meta.dir, "miniapp", "index.html")).text();
  test("the script still parses", async () => {
    const m = [...(await html).matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(m.length).toBeGreaterThan(0);
    for (const x of m) expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(x[1])).not.toThrow();
  });
  test("Board column is renamed, Needs you is its own view, no Inbox or Lanes tab", async () => {
    const t = await html;
    expect(t).toContain("label: 'Waiting on prompt'");
    expect(t).not.toContain("label: 'Needs you'");
    expect(t).toContain("['needs', 'Needs you']");
    expect(t).toContain("Nothing needs you");
    expect(/\['(inbox|lanes)'/i.test(t)).toBe(false);
  });
  const pure = async () => {
    const m = (await html).match(/\/\* needs:pure:start \*\/([\s\S]*?)\/\* needs:pure:end \*\//);
    expect(m).not.toBeNull();
    return new Function(`${m?.[1] ?? ""}; return { badgeText, shouldAutoOpenNeeds };`)() as {
      badgeText: (n: unknown) => string;
      shouldAutoOpenNeeds: (a: {
        count: number;
        userChose: boolean;
        rememberedView: string | null;
        firstOpenDecided: boolean;
      }) => boolean;
    };
  };
  test("badgeText: none shows nothing, 1 to 9 the number, more is 9+", async () => {
    const { badgeText } = await pure();
    expect(badgeText(0)).toBe("");
    expect(badgeText(-3)).toBe("");
    expect(badgeText(undefined)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(250)).toBe("9+");
  });
  test("shouldAutoOpenNeeds: only once, only with something waiting, never after a manual choice", async () => {
    const { shouldAutoOpenNeeds } = await pure();
    const base = { count: 2, userChose: false, rememberedView: "board", firstOpenDecided: false };
    expect(shouldAutoOpenNeeds(base)).toBe(true);
    expect(shouldAutoOpenNeeds({ ...base, rememberedView: "list" })).toBe(true);
    expect(shouldAutoOpenNeeds({ ...base, count: 0 })).toBe(false);
    expect(shouldAutoOpenNeeds({ ...base, userChose: true })).toBe(false);
    expect(shouldAutoOpenNeeds({ ...base, firstOpenDecided: true })).toBe(false);
    expect(shouldAutoOpenNeeds({ ...base, rememberedView: "needs" })).toBe(false); // already there
  });
  test("the Needs you button keeps a visible label on a phone and has a badge; the poll is wired", async () => {
    const t = await html;
    expect(t).toContain('.seg-v.n3 button:not([data-sview="needs"]) .seg-l');
    expect(t).toContain("data-nbadge");
    expect(t).toContain("NEEDS_BG_MS");
    expect(t).toContain("setView('needs', false, true)");
  });
  test("the list is read every 5 s while on screen and refreshed at once when the page comes back", async () => {
    const t = await html;
    expect(t).toContain("const NEEDS_MS = 5000;");
    expect(t).toContain("N.ms - (Date.now() - started)");
    expect(t).toContain("window.addEventListener('focus', needsRefresh);");
    const vis = t.match(/doc\.addEventListener\('visibilitychange', \(\) => \{([\s\S]*?)\n {2}\}\);/);
    expect(vis).not.toBeNull();
    expect(vis?.[1]).toContain("needsStop();");
    expect(vis?.[1]).toContain("needsRefresh();");
    expect(t).toContain("WA.onEvent('activated', () => { S.paused = false; needsRefresh();");
  });
});
