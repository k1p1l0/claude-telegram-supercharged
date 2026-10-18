// bun test test/miniapp-usage.test.ts
// The town feed's usage block: what miniapp.ts passes on to the page, and how the page renders it.
// No bot token, no network, no browser.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTownFeed, parseTownUsage } from "../miniapp";

const feed = (usage: unknown) => ({ version: 1, rooms: [], agents: [], usage });

const ok = {
  state: "ok",
  read_at: "2026-10-18T09:00:00Z",
  detail: null,
  no_room: false,
  accounts: [
    {
      number: 1,
      label: "kozak@getmany.io",
      plan: "Max 20x",
      active: true,
      usage_status: "ok",
      five_hour: { name: "5h", pct: 42, countdown: "2h 10m", reset_at: "2026-10-18T11:10:00Z" },
      seven_day: { name: "7d", pct: 81.5, countdown: "3d", reset_at: "2026-10-21T00:00:00Z" },
      scoped: [{ name: "Fable", pct: 12, countdown: null, reset_at: null }],
    },
  ],
};

describe("parseTownUsage (server)", () => {
  test("a missing or malformed block becomes null, and the rest of the feed still parses", () => {
    expect(parseTownFeed(feed(undefined))?.usage).toBeNull();
    expect(parseTownFeed(feed(null))?.usage).toBeNull();
    expect(parseTownFeed(feed("ok"))?.usage).toBeNull();
    expect(parseTownFeed(feed([ok]))?.usage).toBeNull();
    expect(parseTownFeed(feed({ ...ok, state: "great" }))?.usage).toBeNull();
    expect(parseTownFeed(feed({ ...ok, state: "great" }))?.rooms).toEqual([]);
  });

  test("keeps the known fields of a good block", () => {
    const u = parseTownUsage(ok);
    expect(u).toEqual({
      state: "ok",
      read_at: "2026-10-18T09:00:00Z",
      detail: null,
      no_room: false,
      accounts: [
        {
          number: 1,
          label: "kozak@getmany.io",
          plan: "Max 20x",
          active: true,
          usage_status: "ok",
          five_hour: { name: "5h", pct: 42, countdown: "2h 10m", reset_at: "2026-10-18T11:10:00Z" },
          seven_day: { name: "7d", pct: 81.5, countdown: "3d", reset_at: "2026-10-21T00:00:00Z" },
          scoped: [{ name: "Fable", pct: 12, countdown: null, reset_at: null }],
        },
      ],
    });
  });

  test("checks types, clamps numbers and clips strings", () => {
    const u = parseTownUsage({
      state: "stale",
      read_at: "yesterday-ish",
      detail: "x".repeat(1000),
      no_room: "yes",
      extra: "dropped",
      accounts: [
        {
          number: "3",
          label: { evil: true },
          plan: "p".repeat(100),
          active: "true",
          secret: "dropped",
          five_hour: { name: "5h", pct: 180, countdown: 7, reset_at: 123 },
          seven_day: { name: "", pct: 10 },
          scoped: [{ name: "Fable", pct: Number.NaN }, "junk", null, { pct: 5 }],
        },
        "not an account",
        { number: "abc", five_hour: { name: "5h", pct: -4 } },
      ],
    });
    expect(u).not.toBeNull();
    if (!u) return;
    expect(u.state).toBe("stale");
    expect(u.read_at).toBeNull();
    expect(u.detail?.length).toBe(300);
    expect(u.no_room).toBe(false);
    expect(Object.keys(u)).toEqual(["state", "read_at", "detail", "no_room", "accounts"]);
    expect(u.accounts.length).toBe(2);
    const [a, b] = u.accounts;
    expect(a.number).toBe(3);
    expect(a.label).toBe("");
    expect(a.plan.length).toBe(32);
    expect(a.active).toBe(false);
    expect("secret" in a).toBe(false);
    expect(a.five_hour).toEqual({ name: "5h", pct: 100, countdown: "7", reset_at: null });
    expect(a.seven_day).toBeNull();
    expect(a.scoped).toEqual([{ name: "Fable", pct: null, countdown: null, reset_at: null }]);
    expect(b.number).toBeNull();
    expect(b.five_hour?.pct).toBe(0);
    expect(b.scoped).toEqual([]);
  });

  test("caps the number of accounts and scoped windows", () => {
    const acc = { label: "a", scoped: Array.from({ length: 20 }, (_, i) => ({ name: `w${i}`, pct: i })) };
    const u = parseTownUsage({ state: "ok", accounts: Array.from({ length: 30 }, () => acc) });
    expect(u?.accounts.length).toBe(12);
    expect(u?.accounts[0].scoped.length).toBe(8);
  });
});

// ── The page: the usage helpers in miniapp/index.html are pure and sit between two markers ──

const html = readFileSync(join(import.meta.dir, "..", "miniapp", "index.html"), "utf8");
const block = html.match(/\/\* usage:pure:start \*\/([\s\S]*?)\/\* usage:pure:end \*\//);
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ESC[c]);
const svg = (name: string) => `<svg data-i="${name}"></svg>`;
type Page = {
  usageLevel: (pct: number | null) => "ok" | "warn" | "full";
  usageModel: (u: unknown) => {
    show: boolean;
    state: string;
    warn: boolean;
    noRoom: boolean;
    accounts: { key: string; active: boolean; windows: { key: string; level: string }[] }[];
  };
  usageHTML: (u: unknown) => string;
};
const page = new Function("esc", "svg", `${block?.[1] ?? ""}; return { usageLevel, usageModel, usageHTML };`)(
  esc,
  svg,
) as Page;

describe("usage rendering (page)", () => {
  test("the helpers are present in the page", () => {
    expect(block).not.toBeNull();
  });

  test("levels: warn from 80 %, full at 100 %", () => {
    expect(page.usageLevel(null)).toBe("ok");
    expect(page.usageLevel(79.9)).toBe("ok");
    expect(page.usageLevel(80)).toBe("warn");
    expect(page.usageLevel(99.4)).toBe("warn");
    expect(page.usageLevel(100)).toBe("full");
  });

  test("no block, or a non-object, renders nothing", () => {
    expect(page.usageModel(null).show).toBe(false);
    expect(page.usageModel(undefined).show).toBe(false);
    expect(page.usageHTML(null)).toBe("");
    expect(page.usageHTML("ok")).toBe("");
  });

  test("a good block: one meter per window, the active account marked", () => {
    const u = parseTownUsage(ok);
    const m = page.usageModel(u);
    expect(m.show).toBe(true);
    expect(m.warn).toBe(true); // 7d is at 81.5 %
    expect(m.accounts[0].active).toBe(true);
    expect(m.accounts[0].windows.map((w) => w.level)).toEqual(["ok", "warn", "ok"]);
    const out = page.usageHTML(u);
    expect(out.match(/role="meter"/g)?.length).toBe(3);
    expect(out).toContain('aria-valuenow="82"');
    expect(out).toContain("Active");
    expect(out).toContain("Fable");
    expect(out).toContain("Max 20x");
  });

  test("no_room shows a clear warning with the detail", () => {
    const out = page.usageHTML({ ...ok, no_room: true, detail: "All accounts are at their 5 h limit" });
    // The page announces the change once through its live region; the markup itself has no role="alert",
    // so a re-render on the next poll doesn't announce it again.
    expect(out).toContain("u-alert");
    expect(out).not.toContain('role="alert"');
    expect(out).toContain("No room left");
    expect(out).toContain("All accounts are at their 5 h limit");
  });

  test("stale and unavailable get their own states", () => {
    const stale = page.usageHTML({ ...ok, state: "stale" });
    expect(stale).toContain("u-stale");
    expect(stale).toContain('role="meter"');
    const off = page.usageHTML({
      state: "unavailable",
      read_at: null,
      detail: "cswap not found",
      no_room: false,
      accounts: [],
    });
    expect(off).toContain("Usage unavailable");
    expect(off).toContain("cswap not found");
    expect(off).not.toContain('role="meter"');
    const empty = page.usageHTML({ state: "ok", read_at: null, detail: null, no_room: false, accounts: [] });
    expect(empty).toContain("No accounts");
  });

  test("feed text is escaped", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const out = page.usageHTML({
      ...ok,
      detail: evil,
      no_room: true,
      accounts: [
        {
          ...ok.accounts[0],
          label: evil,
          plan: evil,
          scoped: [{ name: evil, pct: 5, countdown: evil, reset_at: null }],
        },
      ],
    });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
