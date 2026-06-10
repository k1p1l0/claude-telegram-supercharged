import { expect, test } from "bun:test";

// server.ts runs as an MCP server at top level. Its boot sequence (mcp.connect,
// bot polling, watchdog) is gated behind `import.meta.main`, so importing it
// here only loads the pure, exported helpers. Dummy env keeps the top-level
// token check / lock acquisition happy during import.
process.env.TELEGRAM_CHANNEL_ENABLED = "1";
process.env.TELEGRAM_BOT_TOKEN = "123456:dummy-token-for-tests";
process.env.TELEGRAM_STATE_DIR = `/tmp/wd-test-${process.pid}`;

const { parsePpidFromStat, isOrphaned, resolveGrandparentPid } = await import("./server.ts");

const HEALTHY = {
  platform: "linux",
  currentPpid: 30619,
  bootPpid: 30619,
  grandparentPid: 4050890,
  isProcessAlive: () => true,
  stdinDestroyed: false,
  stdinReadableEnded: false,
};

test("parsePpidFromStat: extracts ppid when comm contains spaces and parens", () => {
  // Linux /proc/<pid>/stat. comm = "(bun run start)" has spaces AND a ')'.
  const stat = "30623 (bun run start) S 30619 30619 30619 0 -1 ...";
  expect(parsePpidFromStat(stat)).toBe(30619);
});

test("isOrphaned: grandparent (Claude Code) dead → true", () => {
  // launcher still our parent (ppid unchanged), stdin live, but Claude itself
  // is gone — the launcher-deadlock case the immediate-parent check misses.
  expect(
    isOrphaned({ ...HEALTHY, isProcessAlive: (pid) => pid !== 4050890 }),
  ).toBe(true);
});

test("isOrphaned: everything healthy → false (no false positive)", () => {
  expect(isOrphaned(HEALTHY)).toBe(false);
});

test("isOrphaned: reparented (immediate parent died) → true", () => {
  // launcher died → we were adopted by init, so currentPpid != bootPpid.
  expect(isOrphaned({ ...HEALTHY, currentPpid: 1 })).toBe(true);
});

test("isOrphaned: reparenting check skipped on win32 (no POSIX reparenting)", () => {
  expect(isOrphaned({ ...HEALTHY, platform: "win32", currentPpid: 1 })).toBe(false);
});

test("isOrphaned: stdin pipe destroyed or ended → true", () => {
  expect(isOrphaned({ ...HEALTHY, stdinDestroyed: true })).toBe(true);
  expect(isOrphaned({ ...HEALTHY, stdinReadableEnded: true })).toBe(true);
});

test("isOrphaned: grandparent unknown (null) but otherwise healthy → false", () => {
  // Can't resolve Claude's PID — must not false-positive and kill a live bot.
  expect(isOrphaned({ ...HEALTHY, grandparentPid: null })).toBe(false);
});

test("resolveGrandparentPid: uses /proc stat when available", () => {
  const readStat = (pid: number) =>
    pid === 30619 ? "30619 (bun run start) S 4050890 ..." : null;
  const psPpid = () => {
    throw new Error("ps should not be called when /proc works");
  };
  expect(resolveGrandparentPid(30619, readStat, psPpid)).toBe(4050890);
});

test("resolveGrandparentPid: falls back to ps when /proc unavailable (macOS)", () => {
  const readStat = () => null; // no /proc on macOS
  const psPpid = (pid: number) => (pid === 30619 ? 4050890 : null);
  expect(resolveGrandparentPid(30619, readStat, psPpid)).toBe(4050890);
});

test("resolveGrandparentPid: returns null when both fail or resolve to init(1)", () => {
  expect(resolveGrandparentPid(30619, () => null, () => null)).toBe(null);
  // a grandparent of 1 (init) is not a meaningful Claude parent
  expect(
    resolveGrandparentPid(30619, () => "30619 (x) S 1 ...", () => 1),
  ).toBe(null);
});
