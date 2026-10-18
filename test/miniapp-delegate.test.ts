// bun test test/miniapp-delegate.test.ts
// The optional Delegate board: where the server finds the private bundle, how GET /api/delegate-bundle
// answers, and the page's pure helpers. The bundles here are tiny stand-ins, not the real board.
// No bot token, no network, no browser (test/miniapp-delegate.browser.test.ts runs the loader in one).
// POSIX only: the reader needs O_NOFOLLOW and user ids, so on Windows it always reads null.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELEGATE_BUNDLE_MAX,
  DELEGATE_OPEN,
  type DelegateRead,
  HTML_HEADERS,
  delegateBundlePath,
  delegateBundleReader,
  delegateBundleResponse,
  parseTownFeed,
  readDelegateBundle,
} from "../miniapp";

const dir = mkdtempSync(join(tmpdir(), "miniapp-delegate-"));
chmodSync(dir, 0o700);
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

// The reader wants a private folder and file: mkdtemp makes the folder 0700, and put() sets 0600 so a umask of
// 002 (common on Linux) does not make the file group-writable.
const put = (path: string, body: string | Uint8Array, mode = 0o600) => {
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
};
const text = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : null);
const uid = process.getuid?.() ?? -1;
const why = (r: DelegateRead) => ("why" in r ? r.why : "");
// A private folder of its own, for tests that change the folder.
let sub = 0;
const privateDir = () => {
  const d = join(dir, `d${++sub}`);
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
};

describe("delegateBundleReader", () => {
  test("no path, a missing file, a missing folder or a folder reads as null", () => {
    expect(delegateBundleReader("")()).toBeNull();
    expect(delegateBundleReader(join(dir, "missing.js"))()).toBeNull();
    expect(delegateBundleReader(join(dir, "no-such-folder", "b.js"))()).toBeNull();
    mkdirSync(join(dir, "folder.js"));
    expect(delegateBundleReader(join(dir, "folder.js"))()).toBeNull();
  });

  test("reads a regular file under the cap", () => {
    const path = put(join(dir, "ok.js"), STUB);
    expect(text(delegateBundleReader(path)())).toBe(STUB);
    expect(text(delegateBundleReader(put(join(dir, "ok644.js"), STUB, 0o644))())).toBe(STUB);
  });

  test("refuses a file over the cap", () => {
    const path = put(join(dir, "big.js"), "x".repeat(101));
    expect(delegateBundleReader(path, { max: 100 })()).toBeNull();
    expect(why(readDelegateBundle(path, 100, uid))).toContain("over 100 bytes");
    put(path, "x".repeat(100));
    expect(delegateBundleReader(path, { max: 100 })()?.length).toBe(100);
    expect(DELEGATE_BUNDLE_MAX).toBe(3 * 1024 * 1024);
  });

  test("keeps the file until it changes, and drops it when it goes away", () => {
    const path = put(join(dir, "change.js"), "a");
    const read = delegateBundleReader(path);
    const first = read();
    expect(read()).toBe(first); // same object: not read again
    put(path, "bb");
    expect(text(read())).toBe("bb");
    rmSync(path);
    expect(read()).toBeNull();
  });

  test("a file renamed into place with the same size is read again (the key has the inode)", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), "aa");
    const read = delegateBundleReader(path);
    expect(text(read())).toBe("aa");
    renameSync(put(join(d, "next.js"), "bb"), path);
    expect(text(read())).toBe("bb");
  });

  test("a symlink to a good file is refused, and O_NOFOLLOW refuses it too if one is swapped in", () => {
    const d = privateDir();
    const target = put(join(d, "real.js"), STUB);
    const link = join(d, "b.js");
    symlinkSync(target, link);
    expect(delegateBundleReader(link)()).toBeNull();
    expect(why(readDelegateBundle(link, 100, uid))).toContain("not a regular file");
    // The second line of defence, on its own: open() with the reader's flags fails on a symlink (ELOOP).
    expect(() => openSync(link, DELEGATE_OPEN)).toThrow();
  });

  test("a symlinked folder is refused, even when the folder it points to is fine", () => {
    const d = privateDir();
    put(join(d, "b.js"), STUB);
    const link = join(dir, `link${sub}`);
    symlinkSync(d, link);
    expect(delegateBundleReader(join(link, "b.js"))()).toBeNull();
    expect(why(readDelegateBundle(join(link, "b.js"), 100, uid))).toContain("folder is a symlink");
  });

  test("a FIFO is refused at once and never blocks", () => {
    const d = privateDir();
    const fifo = join(d, "b.js");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    const t0 = Date.now();
    expect(delegateBundleReader(fifo)()).toBeNull();
    expect(why(readDelegateBundle(fifo, 100, uid))).toContain("not a regular file");
    // Swapped in after the lstat, it would be opened: with O_NONBLOCK open() returns at once, and fstat says FIFO.
    const fd = openSync(fifo, DELEGATE_OPEN);
    try {
      expect(fstatSync(fd).isFIFO()).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("a Unix socket is refused", async () => {
    const d = privateDir();
    const sock = join(d, "b.js");
    const server = createServer();
    await new Promise<void>((ok) => server.listen(sock, ok));
    try {
      expect(delegateBundleReader(sock)()).toBeNull();
      expect(why(readDelegateBundle(sock, 100, uid))).toContain("not a regular file");
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });

  test("a file that grows after the fstat is refused, and at most size + 1 bytes are read", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), "x".repeat(50));
    const grow = () => appendFileSync(path, "y".repeat(500));
    expect(delegateBundleReader(path, { max: 100, afterStat: grow })()).toBeNull();
    put(path, "x".repeat(50));
    expect(why(readDelegateBundle(path, 100, uid, "", grow))).toContain("grew");
    // Grown past the cap: still refused, without reading the rest.
    put(path, "x".repeat(100));
    expect(why(readDelegateBundle(path, 100, uid, "", grow))).toContain("grew");
    // And one that shrinks.
    put(path, "x".repeat(50));
    expect(why(readDelegateBundle(path, 100, uid, "", () => truncateSync(path, 10)))).toContain("shrank");
    // Left alone, the same file reads fine.
    put(path, "x".repeat(50));
    expect(delegateBundleReader(path, { max: 100 })()?.length).toBe(50);
  });

  test("a folder that group or others can write, or that another user owns, is refused", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), STUB);
    for (const mode of [0o777, 0o770, 0o730, 0o703]) {
      chmodSync(d, mode);
      expect(delegateBundleReader(path)()).toBeNull();
      expect(why(readDelegateBundle(path, 1000, uid))).toContain("folder is writable by group or others");
    }
    chmodSync(d, 0o755);
    expect(text(delegateBundleReader(path)())).toBe(STUB);
    expect(why(readDelegateBundle(path, 1000, uid + 1))).toContain("folder belongs to another user");
    expect(delegateBundleReader(path, { uid: uid + 1 })()).toBeNull();
  });

  test("a file that group or others can write is refused", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), STUB, 0o664);
    expect(delegateBundleReader(path)()).toBeNull();
    expect(why(readDelegateBundle(path, 1000, uid))).toContain("writable by group or others");
    chmodSync(path, 0o602);
    expect(delegateBundleReader(path)()).toBeNull();
    chmodSync(path, 0o644);
    expect(text(delegateBundleReader(path)())).toBe(STUB);
  });

  test("logs each new reason once, and never a missing file", () => {
    const d = privateDir();
    const path = join(d, "b.js");
    const logs: string[] = [];
    const read = delegateBundleReader(path, { log: (m) => logs.push(m) });
    read();
    expect(logs).toEqual([]);
    put(path, STUB, 0o666);
    read();
    read();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("writable by group or others");
    chmodSync(path, 0o600);
    expect(text(read())).toBe(STUB);
    chmodSync(path, 0o666);
    read();
    expect(logs.length).toBe(2);
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
