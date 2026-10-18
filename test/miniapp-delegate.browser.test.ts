// MINIAPP_BROWSER_TESTS=1 bun test test/miniapp-delegate.browser.test.ts
// The Delegate loader from miniapp/index.html in a real Chromium, through Playwright: a bundle that registers and
// then throws (while it runs, from a timer, from a promise, later, in mount) never shows and never loads again.
// Playwright is not a dependency of this repo. Without MINIAPP_BROWSER_TESTS=1 the file skips, so a plain
// `bun test` stays offline. To run it: bun add --no-save playwright && bunx playwright install chromium
// The page is test/fixtures/delegate-harness.html with the loader blocks put in, served on 127.0.0.1 with the
// Mini App's real headers, so the CSP that allows blob: scripts is the one under test. The bundles are tiny stand-ins.
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
  "mount-throws":
    "window.DelegateBoardBundle = { version: 1, mount(el) { window.calls.push('mount'); el.textContent = 'half'; throw new Error('m'); } };",
  // A top-level var in a classic script is a global that delete cannot remove.
  undeletable:
    "var DelegateBoardBundle = { version: 1, mount() { window.calls.push('mount'); return { update() {}, unmount() {} }; } };\nthrow new Error('x');",
  syntax: `${REGISTER}\n}}} not javascript`,
};

const fetches = new Map<string, number>();
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: any = null;
let base = "";

beforeAll(async () => {
  if (!on) return;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
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

  test("late: a throw after mounting unmounts the board and hides it for good", async () => {
    const l = await load("late");
    expect((await l.seen()).hidden).toBe(false);
    await l.page.waitForTimeout(1200);
    expect((await l.seen()).calls).toEqual(["mount", "unmount"]);
    await expectOffForGood("late", l);
    await l.page.close();
  }, 15000);

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
