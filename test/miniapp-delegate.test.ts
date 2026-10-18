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
  utimesSync,
  writeFileSync,
  writeSync,
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
    expect(why(readDelegateBundle(path, 100, uid, "", { afterStat: grow }))).toContain("grew");
    // Grown past the cap: still refused, without reading the rest.
    put(path, "x".repeat(100));
    expect(why(readDelegateBundle(path, 100, uid, "", { afterStat: grow }))).toContain("grew");
    // And one that shrinks.
    put(path, "x".repeat(50));
    expect(why(readDelegateBundle(path, 100, uid, "", { afterStat: () => truncateSync(path, 10) }))).toContain(
      "shrank",
    );
    // Left alone, the same file reads fine.
    put(path, "x".repeat(50));
    expect(delegateBundleReader(path, { max: 100 })()?.length).toBe(50);
  });

  test("a same-size write in place while it is read is refused (its mtime changed)", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), "a".repeat(50));
    // The file was written a while ago, so the write below moves its mtime even on a clock with coarse ticks.
    const aged = () => utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const rewrite = () => {
      const fd = openSync(path, "r+");
      try {
        writeSync(fd, "b".repeat(50), 0);
      } finally {
        closeSync(fd);
      }
    };
    aged();
    expect(why(readDelegateBundle(path, 100, uid, "", { afterStat: rewrite }))).toContain("changed while it was read");
    aged();
    expect(delegateBundleReader(path, { max: 100, afterStat: rewrite })()).toBeNull();
    // Left alone, the new bytes read fine.
    expect(text(delegateBundleReader(path, { max: 100 })())).toBe("b".repeat(50));
  });

  test("a folder replaced before the open is refused", () => {
    const d = privateDir();
    const path = put(join(d, "b.js"), STUB);
    const swap = () => {
      renameSync(d, `${d}.old`);
      mkdirSync(d, { mode: 0o700 });
      chmodSync(d, 0o700);
      put(join(d, "b.js"), "window.swapped = 1;");
    };
    expect(why(readDelegateBundle(path, 1000, uid, "", { beforeOpen: swap }))).toContain("folder changed");
  });

  test("a folder or a folder above it swapped in for the open and back before the checks is refused", () => {
    // One case the check after the open catches. It does not rule out a swap timed around each check: see the README.
    // The file's folder: the check of the folder passes again, but the path no longer leads to the opened file.
    const d = privateDir();
    const path = put(join(d, "b.js"), STUB);
    const other = privateDir();
    put(join(other, "b.js"), "window.swapped = 1;");
    const away = `${d}.away`;
    const parentIn = () => {
      renameSync(d, away);
      renameSync(other, d);
    };
    const parentBack = () => {
      renameSync(d, other);
      renameSync(away, d);
    };
    expect(why(readDelegateBundle(path, 1000, uid, "", { beforeOpen: parentIn, afterOpen: parentBack }))).toContain(
      "replaced while it was opened",
    );
    expect(text(delegateBundleReader(path)())).toBe(STUB);
    // A folder above it, with a private folder of ours inside: caught the same way.
    const top = privateDir();
    mkdirSync(join(top, "p"), { mode: 0o700 });
    const deep = put(join(top, "p", "b.js"), STUB);
    const fake = privateDir();
    mkdirSync(join(fake, "p"), { mode: 0o700 });
    put(join(fake, "p", "b.js"), "window.swapped = 1;");
    const topAway = `${top}.away`;
    const topIn = () => {
      renameSync(top, topAway);
      renameSync(fake, top);
    };
    const topBack = () => {
      renameSync(top, fake);
      renameSync(topAway, top);
    };
    expect(why(readDelegateBundle(deep, 1000, uid, "", { beforeOpen: topIn, afterOpen: topBack }))).toContain(
      "replaced while it was opened",
    );
    expect(text(delegateBundleReader(deep)())).toBe(STUB);
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
  delegateOwns: (ev: unknown, url: string, active?: boolean) => boolean;
};
const page = new Function(
  `${block?.[1] ?? ""}; return { delegateApi, delegateProps, delegateHandle, delegateOwns };`,
)() as Page;

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

describe("delegateOwns (which errors are the bundle's)", () => {
  const url = "blob:https://board.example/1234";

  test("an error event counts when it names the bundle as its file, and only then", () => {
    expect(page.delegateOwns({ filename: url, error: new Error("x") }, url)).toBe(true);
    expect(page.delegateOwns({ filename: "https://board.example/", error: new Error("x") }, url, true)).toBe(false);
    expect(page.delegateOwns({ filename: url }, "")).toBe(false);
    expect(page.delegateOwns(null, url, true)).toBe(false);
  });

  test("otherwise a stack that names it counts, and one that names only another script does not", () => {
    const own = { stack: `Error: x\n    at f (${url}:1:20)` };
    expect(page.delegateOwns({ reason: own }, url)).toBe(true);
    expect(page.delegateOwns({ error: own }, url)).toBe(true);
    expect(page.delegateOwns({ reason: { stack: "Error: x\n    at g (https://board.example/:9:1)" } }, url, true)).toBe(
      false,
    );
    expect(page.delegateOwns({ reason: { stack: "g@https://board.example/app.js:9:1" } }, url, true)).toBe(false);
  });

  test("an error that names no script counts while the bundle is active, loading or running (fails closed)", () => {
    for (const reason of [
      "plain value",
      undefined,
      null,
      42,
      {},
      { stack: "TypeError: Failed to fetch" },
      // Another blob: URL is not the page's own code (the bundle could have made it).
      { stack: "Error: x\n    at h (blob:https://board.example/5678:1:2)" },
      {
        get stack() {
          throw new Error("no stack");
        },
      },
    ]) {
      expect(page.delegateOwns({ reason }, url, true)).toBe(true);
      expect(page.delegateOwns({ reason }, url, false)).toBe(false);
    }
    expect(page.delegateOwns({ error: null, message: "Script error." }, url, true)).toBe(true);
  });
});

// ── The loader itself (between the loader markers), in a fake page ──
// The fake runs a bundle the way a browser runs a script: a throw while it runs becomes a window error event that
// names the blob URL, and then the script's load event fires anyway. fault() and reject() stand in for a timer or a
// promise in the bundle that fails later. test/miniapp-delegate.browser.test.ts runs the same paths in Chromium.

const loader = html.match(/\/\* delegate:loader:start \*\/([\s\S]*?)\/\* delegate:loader:end \*\//);
const REGISTER = `window.DelegateBoardBundle = { version: 1, mount(el, p) {
  window.calls.push('mount'); el.innerHTML = 'board';
  return { update() { window.calls.push('update'); }, unmount() { window.calls.push('unmount'); } };
} };`;

type Loader = {
  DG: { state: string; api: unknown; handle: unknown; retryAt: number };
  dgLoad: () => Promise<void>;
  dgSync: () => void;
};

function fakePage(bundle: string | null | Error, status = 200) {
  const listeners: Record<string, ((ev: unknown) => void)[]> = { error: [], unhandledrejection: [] };
  const fire = (type: string, ev: unknown) => {
    for (const f of [...listeners[type]]) f(ev);
  };
  const win: Record<string, any> = {
    calls: [] as string[],
    addEventListener(type: string, f: (ev: unknown) => void) {
      if (!listeners[type].includes(f)) listeners[type].push(f);
    },
  };
  const blobs = new Map<string, Blob>();
  let nextBlob = 0;
  const fakeURL = {
    createObjectURL: (b: Blob) => {
      const u = `blob:https://board.example/${++nextBlob}`;
      blobs.set(u, b);
      return u;
    },
    revokeObjectURL: (u: string) => blobs.delete(u),
  };
  const doc = {
    createElement: () => ({}) as Record<string, any>,
    head: {
      appendChild(s: Record<string, any>) {
        setTimeout(async () => {
          const b = blobs.get(s.src);
          if (!b) return s.onerror?.();
          const src = s.src as string;
          const err = (error: unknown) => fire("error", { filename: src, error, message: String(error) });
          const fault = (e: unknown, ms = 0) => setTimeout(() => err(e), ms);
          const reject = (reason: unknown, ms = 0) => setTimeout(() => fire("unhandledrejection", { reason }), ms);
          try {
            new Function("window", "fault", "reject", `"use strict";\n${await b.text()}`)(win, fault, reject);
          } catch (e) {
            err(e);
          }
          s.onload?.();
        }, 0);
      },
    },
  };
  const sec = { hidden: true };
  const el = {
    innerHTML: "",
    get firstChild() {
      return this.innerHTML ? {} : null;
    },
  };
  const $ = (q: string) => (q === "#tw-dg" ? sec : q === "#tw-dg-mount" ? el : null);
  const T = { data: { agents: [], tasks: [] } };
  let fetches = 0;
  const fakeFetch = async () => {
    fetches++;
    if (bundle instanceof Error) throw bundle;
    return bundle === null ? new Response(null, { status: 404 }) : new Response(bundle, { status });
  };
  const dg = new Function(
    "window",
    "doc",
    "$",
    "T",
    "WA",
    "TIMEOUT_MS",
    "scheme",
    "fetch",
    "URL",
    `"use strict";\n${block?.[1] ?? ""}\n${loader?.[1] ?? ""}\nreturn { DG, dgLoad, dgSync };`,
  )(win, doc, $, T, null, 2000, () => "light", fakeFetch, fakeURL) as Loader;
  return { dg, win, sec, el, fire, fetches: () => fetches };
}
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Off for good: hidden, empty, the global gone or ignored, and no new fetch however often the page syncs.
function expectOffForGood(p: ReturnType<typeof fakePage>) {
  expect(p.dg.DG.state).toBe("off");
  expect(p.dg.DG.api).toBeNull();
  expect(p.dg.DG.handle).toBeNull();
  expect(p.sec.hidden).toBe(true);
  expect(p.el.innerHTML).toBe("");
  const n = p.fetches();
  for (let i = 0; i < 3; i++) p.dg.dgSync();
  expect(p.fetches()).toBe(n);
  expect(p.dg.DG.state).toBe("off");
}

describe("Delegate loader fails closed (fake page)", () => {
  test("the loader is present in the page", () => {
    expect(loader).not.toBeNull();
  });

  test("a good bundle mounts once, shows the section and gets updates", async () => {
    const p = fakePage(REGISTER);
    await p.dg.dgLoad();
    expect(p.dg.DG.state).toBe("ready");
    expect(p.sec.hidden).toBe(false);
    expect(p.el.innerHTML).toBe("board");
    p.dg.dgSync();
    expect(p.win.calls).toEqual(["mount", "update"]);
  });

  test("registers, then throws while it runs: nothing mounts and the global is deleted", async () => {
    const p = fakePage(`${REGISTER}\nthrow new Error('after register');`);
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual([]);
    expect("DelegateBoardBundle" in p.win).toBe(false);
    expectOffForGood(p);
  });

  test("registers, then a timer throws right after: nothing mounts", async () => {
    const p = fakePage(`${REGISTER}\nfault(new Error('async'), 0);`);
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual([]);
    expect("DelegateBoardBundle" in p.win).toBe(false);
    expectOffForGood(p);
  });

  test("registers, then a promise rejects with a plain value while it loads: nothing mounts", async () => {
    const p = fakePage(`${REGISTER}\nreject('nope', 0);`);
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual([]);
    expectOffForGood(p);
  });

  test("a later throw from the bundle unmounts the board and hides it for good", async () => {
    const p = fakePage(`${REGISTER}\nfault(new Error('late'), 450);`);
    await p.dg.dgLoad();
    expect(p.sec.hidden).toBe(false);
    await wait(400);
    expect(p.win.calls).toEqual(["mount", "unmount"]);
    expectOffForGood(p);
  });

  test("a later rejection with a plain value or no stack unmounts the board and hides it for good", async () => {
    const reasons = [
      "'late'",
      "undefined",
      "{}",
      "{ stack: 'TypeError: Failed to fetch' }",
      "{ get stack() { throw 1; } }",
    ];
    await Promise.all(
      reasons.map(async (reason) => {
        const p = fakePage(`${REGISTER}\nreject(${reason}, 450);`);
        await p.dg.dgLoad();
        expect(p.dg.DG.state).toBe("ready");
        expect(p.sec.hidden).toBe(false);
        await wait(400);
        expect(p.win.calls).toEqual(["mount", "unmount"]);
        expectOffForGood(p);
      }),
    );
  });

  test("a plain-value rejection from anywhere turns a running board off: it cannot be traced", async () => {
    const p = fakePage(REGISTER);
    await p.dg.dgLoad();
    p.fire("unhandledrejection", { reason: "plain value" });
    expect(p.win.calls).toEqual(["mount", "unmount"]);
    expectOffForGood(p);
  });

  test("mount throws: hidden, the global deleted, no retry", async () => {
    const p = fakePage(
      "window.DelegateBoardBundle = { version: 1, mount(el) { window.calls.push('mount'); el.innerHTML = 'half'; throw new Error('m'); } };",
    );
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual(["mount"]);
    expect("DelegateBoardBundle" in p.win).toBe(false);
    expectOffForGood(p);
  });

  test("mount returns no update(): its unmount() is called and the board stays off", async () => {
    const p = fakePage(
      "window.DelegateBoardBundle = { version: 1, mount() { window.calls.push('mount'); return { unmount() { window.calls.push('unmount'); } }; } };",
    );
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual(["mount", "unmount"]);
    expectOffForGood(p);
  });

  test("an update() that throws turns the board off", async () => {
    const p = fakePage(
      "window.DelegateBoardBundle = { version: 1, mount() { return { update() { throw new Error('u'); }, unmount() { window.calls.push('unmount'); } }; } };",
    );
    await p.dg.dgLoad();
    expect(p.sec.hidden).toBe(false);
    p.dg.dgSync();
    expect(p.win.calls).toEqual(["unmount"]);
    expectOffForGood(p);
  });

  test("a global the bundle made undeletable is ignored after a throw", async () => {
    const p = fakePage(`Object.defineProperty(window, 'DelegateBoardBundle', { configurable: false, value: {
      version: 1, mount() { window.calls.push('mount'); return { update() {}, unmount() {} }; } } });
    throw new Error('x');`);
    await p.dg.dgLoad();
    expect("DelegateBoardBundle" in p.win).toBe(true);
    expect(p.win.calls).toEqual([]);
    expectOffForGood(p);
  });

  test("a global set before the load does not count", async () => {
    const p = fakePage("/* registers nothing */");
    p.win.DelegateBoardBundle = { version: 1, mount: () => p.win.calls.push("stale") };
    await p.dg.dgLoad();
    expect(p.win.calls).toEqual([]);
    expectOffForGood(p);
  });

  test("errors from the page's own code do not turn a running board off", async () => {
    const p = fakePage(REGISTER);
    await p.dg.dgLoad();
    p.fire("error", { filename: "https://board.example/", error: new Error("page") });
    p.fire("unhandledrejection", { reason: { stack: "Error: page\n    at x (https://board.example/:1:1)" } });
    p.fire("unhandledrejection", { reason: { stack: "x@https://board.example/:1:1" } });
    expect(p.dg.DG.state).toBe("ready");
    expect(p.sec.hidden).toBe(false);
  });

  test("no bundle (404) or another version: off, without a retry", async () => {
    const none = fakePage(null);
    await none.dg.dgLoad();
    expectOffForGood(none);
    const v2 = fakePage("window.DelegateBoardBundle = { version: 2, mount() { window.calls.push('mount'); } };");
    await v2.dg.dgLoad();
    expect(v2.win.calls).toEqual([]);
    expectOffForGood(v2);
  });

  test("a network error (no bundle ran yet) waits and tries again later", async () => {
    const p = fakePage(new Error("offline"));
    await p.dg.dgLoad();
    expect(p.dg.DG.state).toBe("idle");
    expect(p.dg.DG.retryAt).toBeGreaterThan(Date.now());
    p.dg.dgSync();
    expect(p.fetches()).toBe(1);
  });
});
