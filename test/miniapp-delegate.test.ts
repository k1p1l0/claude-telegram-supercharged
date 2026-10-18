// bun test test/miniapp-delegate.test.ts
// The optional Delegate board: where the server finds the private bundle, how GET /api/delegate-bundle
// answers, and the page's pure helpers. The bundles here are tiny stand-ins, not the real board.
// No bot token, no network, no browser.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATE_BUNDLE_MAX,
  HTML_HEADERS,
  delegateBundlePath,
  delegateBundleReader,
  delegateBundleResponse,
  parseTownFeed,
} from "../miniapp";

const dir = mkdtempSync(join(tmpdir(), "miniapp-delegate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const STUB = "window.DelegateBoardBundle = { version: 1, mount: function () {} };";

describe("delegateBundlePath", () => {
  test("defaults to the private folder in the channel's state dir", () => {
    expect(delegateBundlePath({}, "/home/u")).toBe(
      "/home/u/.claude/channels/telegram/private/delegate-board.miniapp.js",
    );
    expect(delegateBundlePath({ TELEGRAM_MINIAPP_DELEGATE_BUNDLE: "   " }, "/home/u")).toBe(
      "/home/u/.claude/channels/telegram/private/delegate-board.miniapp.js",
    );
  });

  test("an absolute TELEGRAM_MINIAPP_DELEGATE_BUNDLE wins; a relative one turns the board off", () => {
    expect(delegateBundlePath({ TELEGRAM_MINIAPP_DELEGATE_BUNDLE: " /opt/board.js " }, "/home/u")).toBe(
      "/opt/board.js",
    );
    expect(delegateBundlePath({ TELEGRAM_MINIAPP_DELEGATE_BUNDLE: "board.js" }, "/home/u")).toBe("");
    expect(delegateBundlePath({ TELEGRAM_MINIAPP_DELEGATE_BUNDLE: "../board.js" }, "/home/u")).toBe("");
  });
});

describe("delegateBundleReader", () => {
  test("no path, a missing file or a folder reads as null", () => {
    expect(delegateBundleReader("")()).toBeNull();
    expect(delegateBundleReader(join(dir, "missing.js"))()).toBeNull();
    mkdirSync(join(dir, "folder.js"));
    expect(delegateBundleReader(join(dir, "folder.js"))()).toBeNull();
  });

  test("reads a file under the cap", () => {
    const path = join(dir, "ok.js");
    writeFileSync(path, STUB);
    expect(new TextDecoder().decode(delegateBundleReader(path)() ?? undefined)).toBe(STUB);
  });

  test("refuses a file over the cap", () => {
    const path = join(dir, "big.js");
    writeFileSync(path, "x".repeat(101));
    expect(delegateBundleReader(path, 100)()).toBeNull();
    writeFileSync(path, "x".repeat(100));
    expect(delegateBundleReader(path, 100)()?.length).toBe(100);
    expect(DELEGATE_BUNDLE_MAX).toBe(3 * 1024 * 1024);
  });

  test("keeps the file until it changes, and drops it when it goes away", () => {
    const path = join(dir, "change.js");
    writeFileSync(path, "a");
    const read = delegateBundleReader(path);
    const first = read();
    expect(read()).toBe(first); // same object: not read again
    writeFileSync(path, "bb");
    expect(new TextDecoder().decode(read() ?? undefined)).toBe("bb");
    rmSync(path);
    expect(read()).toBeNull();
  });
});

describe("delegateBundleResponse (GET /api/delegate-bundle)", () => {
  const code = new TextEncoder().encode(STUB);

  test("no signed-in user on the allowlist: 401, and the file is not read", async () => {
    let reads = 0;
    const res = delegateBundleResponse(null, () => {
      reads++;
      return code;
    });
    expect(res.status).toBe(401);
    expect(reads).toBe(0);
    expect(await res.text()).not.toContain("DelegateBoardBundle");
  });

  test("no bundle: a plain 404 with no detail", async () => {
    const res = delegateBundleResponse("42", () => null);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  test("a bundle: JavaScript that no cache keeps", async () => {
    const res = delegateBundleResponse("42", () => code);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(STUB);
  });
});

describe("page headers and feed", () => {
  test("the CSP lets scripts run from blob: and nothing else changes for other resources", () => {
    const csp = HTML_HEADERS["Content-Security-Policy"];
    const directive = (name: string) => csp.split(";").find((d) => d.trim().startsWith(`${name} `)) ?? "";
    expect(directive("script-src")).toContain("blob:");
    expect(directive("default-src")).not.toContain("blob:");
    expect(directive("connect-src")).not.toContain("blob:");
  });

  test("town tasks keep a short priority when the feed sends one", () => {
    const f = parseTownFeed({
      version: 1,
      rooms: [],
      agents: [],
      tasks: [
        { id: "1", title: "a", state: "open", owner: "x", priority: "high" },
        { id: "2", title: "b", state: "open", owner: "x" },
        { id: "3", title: "c", state: "open", owner: "x", priority: { evil: true } },
        { id: "4", title: "d", state: "open", owner: "x", priority: "p".repeat(40) },
      ],
    });
    expect(f?.tasks[0].priority).toBe("high");
    expect("priority" in (f?.tasks[1] ?? {})).toBe(false);
    expect("priority" in (f?.tasks[2] ?? {})).toBe(false);
    expect((f?.tasks[3].priority ?? "").length).toBeLessThanOrEqual(16);
  });
});

// ── The page: the loader's pure helpers in miniapp/index.html sit between two markers ──

const html = readFileSync(join(import.meta.dir, "..", "miniapp", "index.html"), "utf8");
const block = html.match(/\/\* delegate:pure:start \*\/([\s\S]*?)\/\* delegate:pure:end \*\//);
type Page = {
  delegateApi: (w: unknown) => { mount: unknown } | null;
  delegateProps: (d: unknown, theme: unknown) => { town: { agents: unknown[]; tasks: unknown[] }; theme: string };
  delegateHandle: (h: unknown) => boolean;
};
const page = new Function(`${block?.[1] ?? ""}; return { delegateApi, delegateProps, delegateHandle };`)() as Page;

describe("Delegate loader (page)", () => {
  test("the helpers are present in the page", () => {
    expect(block).not.toBeNull();
  });

  test("takes only a version 1 bundle with a mount function", () => {
    const mount = () => ({});
    expect(page.delegateApi({})).toBeNull();
    expect(page.delegateApi(null)).toBeNull();
    expect(page.delegateApi({ DelegateBoardBundle: { version: 2, mount } })).toBeNull();
    expect(page.delegateApi({ DelegateBoardBundle: { version: "1", mount } })).toBeNull();
    expect(page.delegateApi({ DelegateBoardBundle: { version: 1, mount: "no" } })).toBeNull();
    expect(page.delegateApi({ DelegateBoardBundle: { version: 1, mount } })?.mount).toBe(mount);
  });

  test("passes the town's agents and tasks through as they are, and a light or dark theme", () => {
    const agents = [{ name: "a" }];
    const tasks = [{ id: "1", title: "t", state: "open", owner: "a" }];
    const p = page.delegateProps({ agents, tasks, rooms: [] }, "dark");
    expect(p.town.agents).toBe(agents);
    expect(p.town.tasks).toBe(tasks);
    expect(p.theme).toBe("dark");
    expect(page.delegateProps(null, "sepia")).toEqual({ town: { agents: [], tasks: [] }, theme: "light" });
    expect(page.delegateProps({ agents: "x", tasks: null }, "light").town).toEqual({ agents: [], tasks: [] });
  });

  test("a mount result needs update and unmount", () => {
    const fn = () => {};
    expect(page.delegateHandle({ update: fn, unmount: fn })).toBe(true);
    expect(page.delegateHandle({ update: fn })).toBe(false);
    expect(page.delegateHandle(undefined)).toBe(false);
  });
});
