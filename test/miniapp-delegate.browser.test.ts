// MINIAPP_BROWSER_TESTS=1 bun test test/miniapp-delegate.browser.test.ts
// The Delegate loader from miniapp/index.html in a real Chromium, through Playwright: a bundle that registers and
// then throws (while it runs, from a timer, from a promise, later, in mount) never shows and never loads again.
// Playwright is not a dependency of this repo. Without MINIAPP_BROWSER_TESTS=1 the file skips, so a plain
// `bun test` stays offline. To run it: bun add --no-save playwright && bunx playwright install chromium
// The page is test/fixtures/delegate-harness.html with the loader blocks put in, served on 127.0.0.1 with the
// Mini App's real headers, so the CSP that allows blob: scripts is the one under test. The bundles are tiny stand-ins.
// One test loads the whole of miniapp/index.html instead, with stand-in api/state and api/town answers, to show that
// the rest of the Mini App keeps working after the board turns itself off. telegram.org is answered with an empty script.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HTML_HEADERS } from "../miniapp";

const on = process.env.MINIAPP_BROWSER_TESTS === "1";
const pw: any = on ? await import(String("playwright")) : null;

const html = readFileSync(join(import.meta.dir, "..", "miniapp", "index.html"), "utf8");
const pure = html.match(/\/\* delegate:pure:start \*\/([\s\S]*?)\/\* delegate:pure:end \*\//)?.[1] ?? "";
const loader = html.match(/\/\* delegate:loader:start \*\/([\s\S]*?)\/\* delegate:loader:end \*\//)?.[1] ?? "";
const harness = readFileSync(join(import.meta.dir, "fixtures", "delegate-harness.html"), "utf8").replace(
  "/* DELEGATE_CODE */",
  () => `${pure}\n${loader}`,
);

const REGISTER = `window.DelegateBoardBundle = { version: 1, mount(el, p) {
  window.calls.push('mount'); el.textContent = 'board';
  return { update() { window.calls.push('update'); }, unmount() { window.calls.push('unmount'); } };
} };`;
const BUNDLES: Record<string, string> = {
  ok: REGISTER,
  "throw-sync": `${REGISTER}\nthrow new Error('after register');`,
  "throw-timer": `${REGISTER}\nsetTimeout(() => { throw new Error('from a timer'); }, 0);`,
  "reject-error": `${REGISTER}\nPromise.reject(new Error('from a promise'));`,
  "reject-plain": `${REGISTER}\nPromise.reject('plain value');`,
  late: `${REGISTER}\nsetTimeout(() => { throw new Error('late'); }, 1000);`,
  "late-plain": `${REGISTER}\nsetTimeout(() => { Promise.reject('late plain value'); }, 1000);`,
  "mount-throws":
    "window.DelegateBoardBundle = { version: 1, mount(el) { window.calls.push('mount'); el.textContent = 'half'; throw new Error('m'); } };",
  // A top-level var in a classic script is a global that delete cannot remove.
  undeletable:
    "var DelegateBoardBundle = { version: 1, mount() { window.calls.push('mount'); return { update() {}, unmount() {} }; } };\nthrow new Error('x');",
  syntax: `${REGISTER}\n}}} not javascript`,
};

const fetches = new Map<string, number>();
// The whole Mini App page under /full/: how often it asked for each route. Each answer carries its count.
const full = { state: 0, town: 0, bundle: 0 };
const NO_STORE = { "Cache-Control": "no-store" };
function fullRoute(route: string | undefined): Response {
  if (!route) return new Response(html, { headers: HTML_HEADERS });
  if (route === "delegate-bundle") {
    full.bundle++;
    return new Response(BUNDLES.ok, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", ...NO_STORE },
    });
  }
  if (route === "town") {
    const n = ++full.town;
    const feed = {
      schema_version: 1,
      generated_at: Date.now(),
      machine: "test",
      rooms: [{ id: "hub", title: `Hub ${n}`, kind: "hub" }],
      agents: [],
      messages: [],
      tasks: [],
    };
    return Response.json(feed, { headers: NO_STORE });
  }
  const n = ++full.state;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const totals = {
    sessions: n,
    busy: 0,
    waiting: 0,
    agentsRunning: 0,
    agents24h: 0,
    toolCalls24h: 0,
    tokens24h: tokens,
  };
  const snap = {
    now: Date.now(),
    host: "test",
    ready: true,
    totals,
    hourly: [],
    sessions: [],
    activity: [],
    projects: [],
  };
  return Response.json({ ...snap, town: true, machines: [] }, { headers: NO_STORE });
}
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: any = null;
let base = "";

beforeAll(async () => {
  if (!on) return;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const f = new URL(req.url).pathname.match(/^\/full\/(?:api\/(state|town|delegate-bundle))?$/);
      if (f) return fullRoute(f[1]);
      const m = new URL(req.url).pathname.match(/^\/s\/([\w-]+)\/(api\/delegate-bundle)?$/);
      if (!m || !(m[1] in BUNDLES)) return new Response(null, { status: 404 });
      if (!m[2]) return new Response(harness, { headers: HTML_HEADERS });
      fetches.set(m[1], (fetches.get(m[1]) ?? 0) + 1);
      return new Response(BUNDLES[m[1]], {
        headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await pw.chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type Seen = { state: string; hidden: boolean; text: string; calls: string[]; global: boolean; api: boolean };
async function load(name: string) {
  const page = await browser.newPage();
  const csp: string[] = [];
  page.on("console", (m: any) => {
    if (/Content Security Policy/i.test(m.text())) csp.push(m.text());
  });
  await page.goto(`${base}/s/${name}/`);
  await page.evaluate(() => (window as any).__dg.dgLoad());
  const seen = async (): Promise<Seen> =>
    page.evaluate(() => {
      const w = window as any;
      return {
        state: w.__dg.DG.state,
        hidden: (document.getElementById("tw-dg") as HTMLElement).hidden,
        text: (document.getElementById("tw-dg-mount") as HTMLElement).textContent ?? "",
        calls: w.calls.slice(),
        global: "DelegateBoardBundle" in w,
        api: w.__dg.DG.api !== null,
      };
    });
  return { page, seen, csp };
}
// Off for good: hidden, empty, nothing mounted or left mounted, and no second fetch however often the page syncs.
async function expectOffForGood(name: string, l: Awaited<ReturnType<typeof load>>) {
  const s = await l.seen();
  expect(s.state).toBe("off");
  expect(s.api).toBe(false);
  expect(s.hidden).toBe(true);
  expect(s.text).toBe("");
  await l.page.evaluate(() => {
    const dg = (window as any).__dg;
    for (let i = 0; i < 3; i++) dg.dgSync();
  });
  await l.page.waitForTimeout(100);
  expect(fetches.get(name)).toBe(1);
  expect((await l.seen()).state).toBe("off");
}

describe.skipIf(!on)("Delegate loader in Chromium", () => {
  test("a good bundle runs from a blob: URL under the real CSP, mounts once and gets updates", async () => {
    const l = await load("ok");
    let s = await l.seen();
    expect(l.csp).toEqual([]);
    expect(s.state).toBe("ready");
    expect(s.hidden).toBe(false);
    expect(s.text).toBe("board");
    await l.page.evaluate(() => (window as any).__dg.dgSync());
    s = await l.seen();
    expect(s.calls).toEqual(["mount", "update"]);
    await l.page.close();
  }, 15000);

  for (const name of ["throw-sync", "throw-timer", "reject-error", "reject-plain", "syntax"]) {
    test(`${name}: nothing mounts, the global is deleted, and it never loads again`, async () => {
      const l = await load(name);
      const s = await l.seen();
      expect(s.calls).toEqual([]);
      expect(s.global).toBe(false);
      await expectOffForGood(name, l);
      await l.page.close();
    }, 15000);
  }

  for (const name of ["late", "late-plain"]) {
    test(`${name}: a throw or a plain-value rejection after mounting unmounts the board and hides it for good`, async () => {
      const l = await load(name);
      expect((await l.seen()).hidden).toBe(false);
      await l.page.waitForTimeout(1200);
      expect((await l.seen()).calls).toEqual(["mount", "unmount"]);
      await expectOffForGood(name, l);
      await l.page.close();
    }, 15000);
  }

  test("mount-throws: the half-drawn board is emptied and hidden, the global deleted", async () => {
    const l = await load("mount-throws");
    const s = await l.seen();
    expect(s.calls).toEqual(["mount"]);
    expect(s.global).toBe(false);
    await expectOffForGood("mount-throws", l);
    await l.page.close();
  }, 15000);

  test("undeletable: a var global that cannot be deleted is ignored", async () => {
    const l = await load("undeletable");
    const s = await l.seen();
    expect(s.global).toBe(true);
    expect(s.calls).toEqual([]);
    await expectOffForGood("undeletable", l);
    await l.page.close();
  }, 15000);

  test("full page: after an untraceable rejection turns the board off, the other views keep polling and drawing", async () => {
    full.state = full.town = full.bundle = 0;
    const page = await browser.newPage();
    await page.route("https://telegram.org/**", (r: any) =>
      r.fulfill({ status: 200, contentType: "application/javascript", body: "" }),
    );
    await page.addInitScript(() => {
      (window as any).calls = [];
      try {
        localStorage.setItem("ccab.view", "town");
      } catch {}
    });
    await page.goto(`${base}/full/`);
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    await page.waitForFunction(`!${el("tw-dg")}.hidden && window.calls.includes("mount")`, null, { timeout: 15000 });
    // A rejection with a plain value from the page itself: it names no script, so the board turns off.
    await page.evaluate(() => {
      Promise.reject("page plain value");
    });
    await page.waitForFunction(`${el("tw-dg")}.hidden`, null, { timeout: 5000 });
    const read = () =>
      page.evaluate(() => {
        const text = (id: string) => document.getElementById(id)?.textContent ?? "";
        return {
          tiles: Number(text("tiles").match(/of\s*(\d+)\s*open/)?.[1] ?? 0),
          hub: Number(text("tw-rooms").match(/Hub (\d+)/)?.[1] ?? 0),
          board: text("tw-dg-mount"),
          calls: (window as any).calls.slice() as string[],
        };
      });
    const before = await read();
    const hits = { ...full };
    await page.waitForTimeout(7000); // the state and town polls run every 3 s
    const after = await read();
    expect(full.state).toBeGreaterThanOrEqual(hits.state + 2);
    expect(full.town).toBeGreaterThanOrEqual(hits.town + 2);
    expect(after.tiles).toBeGreaterThan(before.tiles);
    expect(after.hub).toBeGreaterThan(before.hub);
    expect(after.board).toBe("");
    expect(after.calls.filter((c) => c === "mount").length).toBe(1);
    expect(after.calls.at(-1)).toBe("unmount");
    // The other views still switch and draw, and the Town comes back with fresh data and no board.
    await page.click('#view-seg button[data-sview="list"]');
    expect(await page.evaluate(`[${el("town")}.hidden, ${el("sessions")}.hidden]`)).toEqual([true, false]);
    await page.click('#view-seg button[data-sview="town"]');
    await page.waitForFunction(
      `Number((${el("tw-rooms")}.textContent.match(/Hub (\\d+)/) || [])[1] || 0) > ${after.hub}`,
      null,
      { timeout: 10000 },
    );
    expect(await page.evaluate(`${el("tw-dg")}.hidden`)).toBe(true);
    expect(full.bundle).toBe(1);
    await page.close();
  }, 40000);

  test("errors from the page's own code leave a running board alone", async () => {
    const l = await load("ok");
    await l.page.evaluate(() => {
      (window as any).pageThrow();
      (window as any).pageReject();
    });
    await l.page.waitForTimeout(200);
    const s = await l.seen();
    expect(s.state).toBe("ready");
    expect(s.hidden).toBe(false);
    await l.page.close();
  }, 15000);
});
