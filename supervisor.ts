#!/usr/bin/env bun
/**
 * Supervisor for Claude Code with Telegram channel.
 *
 * Spawns claude with --channels, watches for a restart signal file written
 * by the Telegram MCP server when the user requests a full context reset,
 * then kills and restarts the claude process for a fresh session.
 *
 * Signal file: ~/.claude/channels/telegram/data/restart.signal
 *
 * Usage:
 *   bun supervisor.ts [extra claude flags...]
 *   bun supervisor.ts --dangerously-skip-permissions
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

// Resolve paths from the account's real home, not $HOME. A launchd plist that
// overrides HOME (e.g. to give the daemon a separate cwd) otherwise sends every
// path below to the wrong place and the wrapper spawn fails with ENOENT forever.
const REAL_HOME = userInfo().homedir || homedir();
const STATE_DIR = join(REAL_HOME, ".claude", "channels", "telegram");
const DATA_DIR = join(STATE_DIR, "data");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");
const CLAUDE_CMD = "claude";
// Router model: configurable via TELEGRAM_ROUTER_MODEL env var.
// Options: "haiku" (fast, 200K context), "sonnet" (balanced, 1M context), "opus" (deep, 1M context)
// Default: "sonnet" — best balance of speed and context window.
const ROUTER_MODEL = process.env.TELEGRAM_ROUTER_MODEL || "sonnet";
// NOTE (2026-07-30, Claude Code v2.1.220): the telegram channel MCP server is
// silently skipped when a new claude session boots while the previous session
// is still shutting down (plugin single-instance guard). Restarts must leave a
// clean gap — kill the old claude and wait for it to fully exit before
// spawning. Keep spawn args minimal: put behavior instructions for the daemon
// in ~/.claude/CLAUDE.md, not in --append-system-prompt (its interaction with
// --channels is untested; the failures seen correlated with restart overlap,
// but the flag was never proven safe either).
const BASE_ARGS = [
	"--channels",
	"plugin:telegram@claude-plugins-official",
	"--dangerously-skip-permissions",
	"--model",
	ROUTER_MODEL,
];

// Agentic Mode: report every tool call to server.ts, which shows a live
// "Working..." message in Telegram. Passed via --settings so the hook only runs
// in the daemon, never in your interactive sessions. TELEGRAM_AGENTIC_MODE=off
// disables it.
const PROGRESS_HOOK = join(REAL_HOME, ".claude", "scripts", "telegram-progress-hook.ts");
if (process.env.TELEGRAM_AGENTIC_MODE !== "off" && existsSync(PROGRESS_HOOK)) {
	const hook = [{ type: "command", command: `"${process.execPath}" "${PROGRESS_HOOK}"`, timeout: 5 }];
	BASE_ARGS.push(
		"--settings",
		JSON.stringify({
			hooks: {
				PreToolUse: [{ matcher: "*", hooks: hook }],
				PostToolUse: [{ matcher: "*", hooks: hook }],
				Stop: [{ hooks: hook }],
			},
		}),
	);
}

// Extra args passed to this supervisor are forwarded to claude
const EXTRA_ARGS = process.argv.slice(2);

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_UPTIME_MS = 60_000;
const GRACEFUL_TIMEOUT_MS = 5_000;
const CONTEXT_CHECK_INTERVAL_MS = 30_000; // Check context every 30s
const CONTEXT_THRESHOLD_PCT = 50; // Auto-restart when context exceeds 50% — keeps sessions fresh
const MAX_SESSION_UPTIME_MS = 2 * 60 * 60 * 1000; // Force restart after 2 hours regardless of context
const STDOUT_LOG = join(DATA_DIR, "supervisor-stdout.log");
const PID_FILE = join(DATA_DIR, "supervisor.pid");

// Claude Code remembers a failed plugin MCP connection for 15 minutes in
// ~/.claude/mcp-needs-auth-cache.json. The cache is shared by every Claude
// session on the machine and keyed by server name ("plugin:telegram:telegram"),
// so any other session that fails to start the plugin (e.g. a cron or launchd
// job whose PATH lacks bun: "Executable not found in $PATH") makes every new
// session, this daemon included, silently skip the telegram plugin until the
// entry expires. Nothing is logged; the daemon just never gets a poller.
// Drop our entries before each spawn.
const MCP_FAILURE_CACHE = join(process.env.CLAUDE_CONFIG_DIR ?? join(REAL_HOME, ".claude"), "mcp-needs-auth-cache.json");

function clearTelegramMcpFailureCache(): void {
	try {
		const cache = JSON.parse(readFileSync(MCP_FAILURE_CACHE, "utf-8")) as Record<string, unknown>;
		const stale = Object.keys(cache).filter((k) => k.startsWith("plugin:telegram"));
		if (stale.length === 0) return;
		for (const k of stale) delete cache[k];
		const tmp = `${MCP_FAILURE_CACHE}.tmp.${process.pid}`;
		writeFileSync(tmp, JSON.stringify(cache));
		renameSync(tmp, MCP_FAILURE_CACHE);
		log(`cleared cached MCP connection failure for ${stale.join(", ")} (another Claude session failed to start the plugin)`);
	} catch {
		// No cache file yet, or unreadable: nothing to clear.
	}
}
// Delay before restart to let Claude finish sending Telegram replies
const RESTART_DELAY_MS = 3_000;
// Auth watchdog: detect 401 errors and notify via Telegram
const AUTH_CHECK_INTERVAL_MS = 15_000; // Check every 15s
const AUTH_RECOVERY_CHECK_MS = 30_000; // Check for token recovery every 30s

let currentChild: ChildProcess | null = null;
let restartCount = 0;
let lastStartTime = 0;
let shuttingDown = false;
let pendingRestart = false;
let authFailed = false; // Tracks whether we're in auth-failure state
let lastAuthCheckOffset = 0; // Track where we last read in stdout log

function log(msg: string): void {
	process.stderr.write(
		`[supervisor ${new Date().toISOString()}] ${msg}\n`,
	);
}

function backoffMs(): number {
	const b = BACKOFF_BASE_MS * 2 ** Math.min(restartCount, 5);
	return Math.min(b, BACKOFF_MAX_MS);
}

async function killProcessTree(pid: number, signal: string): Promise<void> {
	try {
		// Kill the entire process group (negative PID)
		process.kill(-pid, signal);
	} catch {
		// If process group kill fails, fall back to direct kill
		try {
			process.kill(pid, signal);
		} catch {}
	}
}

async function killChild(child: ChildProcess): Promise<void> {
	if (!child.pid || child.exitCode !== null) return;

	const pid = child.pid;
	log(`killing process tree (pid=${pid})`);

	// Send SIGTERM to the entire process group
	await killProcessTree(pid, "SIGTERM");

	await new Promise<void>((resolve) => {
		const deadline = setTimeout(() => {
			if (child.exitCode === null) {
				log("graceful timeout — sending SIGKILL to process tree");
				void killProcessTree(pid, "SIGKILL");
			}
			resolve();
		}, GRACEFUL_TIMEOUT_MS);

		child.once("exit", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

function startClaude(): void {
	if (shuttingDown) return;

	const uptime = Date.now() - lastStartTime;
	if (lastStartTime > 0 && uptime > STABLE_UPTIME_MS) {
		restartCount = 0;
	}

	lastStartTime = Date.now();
	clearTelegramMcpFailureCache();
	const args = [...BASE_ARGS, ...EXTRA_ARGS];
	log(`spawning: ${CLAUDE_CMD} ${args.join(" ")}`);
	// Use `expect` wrapper to allocate a PTY and auto-accept the workspace trust dialog.
	// expect spawns Claude with a pseudo-TTY (so it enters interactive mode under launchd)
	// and auto-sends Enter when it sees the "trust this folder" prompt.
	const EXPECT_WRAPPER = join(REAL_HOME, ".claude", "scripts", "claude-daemon-wrapper.exp");
	const child = spawn(EXPECT_WRAPPER, args, {
		stdio: "inherit",
		env: { ...process.env, HOME: REAL_HOME, TELEGRAM_DAEMON_MODE: "1" },
		detached: true, // Create a new process group so we can kill the entire tree
	});
	// Despite detached:true, we still want the child to die with the supervisor.
	// unref() is NOT called — the supervisor event loop keeps running.
	currentChild = child;

	child.on("exit", (code, signal) => {
		currentChild = null;
		if (shuttingDown) return;

		if (pendingRestart) {
			// Restart triggered by signal file — restart immediately
			pendingRestart = false;
			restartCount = 0;
			log("context reset complete — waiting for sub-processes to release connections...");
			setTimeout(startClaude, 2000);
		} else if (code === 0) {
			// Clean exit — user typed /exit or similar
			log("claude exited cleanly (code=0) — restarting after cleanup delay");
			restartCount = 0;
			setTimeout(startClaude, 2000);
		} else {
			// Crash — apply backoff
			restartCount++;
			const delay = backoffMs();
			log(
				`claude crashed (code=${code}, signal=${signal}) — restart #${restartCount} in ${delay}ms`,
			);
			setTimeout(startClaude, delay);
		}
	});

	child.on("error", (err) => {
		log(`failed to spawn claude: ${err.message}`);
		currentChild = null;
		restartCount++;
		const delay = backoffMs();
		setTimeout(startClaude, delay);
	});
}

async function handleRestartSignal(): Promise<void> {
	if (!existsSync(SIGNAL_FILE)) return;
	if (pendingRestart) return; // already handling one

	log("restart signal detected");

	// Read optional delay-until timestamp from the file
	let delayMs = RESTART_DELAY_MS;
	try {
		const content = readFileSync(SIGNAL_FILE, "utf-8").trim();
		const until = Number.parseInt(content, 10);
		if (!Number.isNaN(until) && until > Date.now()) {
			delayMs = until - Date.now();
		}
	} catch {}

	// Consume the signal file immediately
	try {
		rmSync(SIGNAL_FILE, { force: true });
	} catch (err) {
		log(`warning: could not remove signal file: ${err}`);
	}

	log(`waiting ${delayMs}ms for Claude to finish sending replies...`);
	await new Promise((r) => setTimeout(r, delayMs));

	if (currentChild) {
		pendingRestart = true;
		log("terminating current claude session for context reset");
		await killChild(currentChild);
		// The exit handler will detect pendingRestart and call startClaude
	} else {
		log("no running claude process — starting fresh");
		startClaude();
	}
}

function startWatching(): void {
	mkdirSync(DATA_DIR, { recursive: true });

	// fs.watchFile polls reliably on macOS and Linux
	watchFile(SIGNAL_FILE, { interval: 500, persistent: true }, (curr) => {
		if (curr.mtimeMs > 0) {
			void handleRestartSignal();
		}
	});

	log(`watching for restart signal at: ${SIGNAL_FILE}`);
}

// Graceful shutdown of the supervisor itself
async function shutdown(sig: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`received ${sig} — shutting down`);

	unwatchFile(SIGNAL_FILE);
	try { rmSync(PID_FILE, { force: true }); } catch {}

	if (currentChild) {
		await killChild(currentChild);
	}
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Kill any orphaned processes from previous runs. Two classes are caught:
//   1. claude --channels telegram   — the worker itself
//   2. bun server.ts adopted by init (PPID=1) — the bot MCP subprocess
//
// The bot orphans are the dangerous ones: when an old claude session dies
// without cleanly tearing down its MCP child, the bot is adopted by init
// and keeps an exclusive lock on messages.db. New daemons then receive
// messages, react, but their DB writes silently fail — symptom: bot reacts
// but never replies. The 28-day-old PPID=1 orphan we hit on 2026-04-28 is
// the canonical failure this guards against.
//
// PPID=1 is the right scope: a healthy bot is always parented by a live
// claude worker, so PPID=1 only matches genuinely stranded ones.
async function cleanupOrphans(): Promise<void> {
	const { execSync } = await import("node:child_process");
	try {
		const myPid = process.pid;
		const seen = new Set<number>();
		// Class 1: claude worker
		try {
			const r = execSync(`pgrep -f 'claude.*--channels.*telegram' || true`, {
				encoding: "utf-8",
			}).trim();
			for (const line of r.split("\n").filter(Boolean)) {
				const p = Number.parseInt(line.trim(), 10);
				if (!Number.isNaN(p) && p !== myPid) seen.add(p);
			}
		} catch {}
		// Class 2: bot subprocess adopted by init. Any `bun server.ts` with
		// PPID=1 is necessarily a stranded MCP child from a dead claude
		// session — no legitimate `bun server.ts` runs with init as parent.
		try {
			const r = execSync(`pgrep -f 'bun.*server\\.ts' || true`, {
				encoding: "utf-8",
			}).trim();
			for (const line of r.split("\n").filter(Boolean)) {
				const p = Number.parseInt(line.trim(), 10);
				if (Number.isNaN(p) || p === myPid) continue;
				try {
					const ppid = Number.parseInt(
						execSync(`ps -o ppid= -p ${p}`, { encoding: "utf-8" }).trim(),
						10,
					);
					if (ppid === 1) seen.add(p);
				} catch {} // ps failed → process gone; skip
			}
		} catch {}
		if (seen.size === 0) return;

		// Filter out interactive sessions (processes with a TTY are user terminals)
		const orphanPids: number[] = [];
		for (const pid of seen) {
			try {
				const tty = execSync(`ps -p ${pid} -o tty=`, {
					encoding: "utf-8",
				}).trim();
				if (tty && tty !== "??" && tty !== "") {
					log(`skipping pid=${pid} (interactive session on ${tty})`);
					continue;
				}
			} catch {
				// ps failed — process may already be dead, skip it
				continue;
			}
			orphanPids.push(pid);
		}

		for (const pid of orphanPids) {
			log(`killing orphaned process pid=${pid}`);
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}

		if (orphanPids.length > 0) {
			// Give them time to die
			await new Promise((r) => setTimeout(r, 2000));
			// Force kill any survivors
			for (const pid of orphanPids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {} // already dead — fine
			}
		}
	} catch (err) {
		log(`orphan cleanup warning: ${err}`);
	}
}

// ── Auth watchdog ────────────────────────────────────────────────
// Monitors stdout log for authentication_error (401) responses.
// When detected: stops the restart loop, notifies owner via Telegram,
// and polls for token recovery (user runs /login).

function loadBotToken(): string | null {
	const envFile = join(STATE_DIR, ".env");
	try {
		for (const line of readFileSync(envFile, "utf-8").split("\n")) {
			const m = line.match(/^TELEGRAM_BOT_TOKEN=(.+)$/);
			if (m) return m[1].trim();
		}
	} catch {}
	return process.env.TELEGRAM_BOT_TOKEN || null;
}

function getOwnerChatId(): string | null {
	const accessFile = join(STATE_DIR, "access.json");
	try {
		const access = JSON.parse(readFileSync(accessFile, "utf-8"));
		const allowed = access.allowFrom;
		if (Array.isArray(allowed) && allowed.length > 0) return String(allowed[0]);
	} catch {}
	return null;
}

async function sendTelegramNotification(text: string): Promise<boolean> {
	const token = loadBotToken();
	const chatId = getOwnerChatId();
	if (!token || !chatId) {
		log("auth watchdog: cannot send notification — missing bot token or owner chat ID");
		return false;
	}
	try {
		const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
		});
		if (!res.ok) {
			log(`auth watchdog: Telegram API error: ${res.status}`);
			return false;
		}
		return true;
	} catch (err) {
		log(`auth watchdog: failed to send notification: ${err}`);
		return false;
	}
}

async function checkAuthValid(): Promise<boolean> {
	// Quick check: try to hit Claude API via the CLI
	const { execSync } = await import("node:child_process");
	try {
		execSync('claude -p "ping" --max-turns 1 2>&1', {
			encoding: "utf-8",
			timeout: 15_000,
		});
		return true;
	} catch {
		return false;
	}
}

let authWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let authRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let authNotificationSent = false;

function checkStdoutForAuthError(): boolean {
	try {
		const stat = statSync(STDOUT_LOG);
		// Read the last 4KB to catch auth errors in recent output
		const readSize = Math.min(stat.size, 4096);
		const fd = openSync(STDOUT_LOG, "r");
		const buf = Buffer.alloc(readSize);
		readSync(fd, buf, 0, readSize, stat.size - readSize);
		closeSync(fd);
		const tail = buf.toString("utf-8");
		return tail.includes("authentication_error") || tail.includes("Invalid authentication credentials");
	} catch {
		return false;
	}
}

function startAuthWatchdog(): void {
	if (authWatchdogTimer) return;
	authWatchdogTimer = setInterval(async () => {
		if (shuttingDown || authFailed) return;
		if (!checkStdoutForAuthError()) return;

		authFailed = true;
		log("auth watchdog: 401 authentication error detected — entering recovery mode");

		// Notify user via Telegram
		if (!authNotificationSent) {
			const sent = await sendTelegramNotification(
				"⚠️ *Claude Telegram daemon: auth expired*\n\n" +
				"The API session token is invalid (401). " +
				"Messages are not being processed.\n\n" +
				"Run `claude /login` in any terminal to refresh credentials. " +
				"The daemon will auto-recover once auth is valid again."
			);
			if (sent) {
				authNotificationSent = true;
				log("auth watchdog: notification sent to owner via Telegram");
			}
		}

		// Stop the context watchdog — no point checking context when auth is broken
		if (contextWatchdogTimer) {
			clearInterval(contextWatchdogTimer);
			contextWatchdogTimer = null;
		}

		// Kill the current broken session
		if (currentChild) {
			log("auth watchdog: killing broken session");
			pendingRestart = false; // prevent auto-restart
			shuttingDown = true; // temporarily prevent restart
			await killChild(currentChild);
			shuttingDown = false;
			currentChild = null;
		}

		// Start polling for auth recovery
		startAuthRecoveryPoller();
	}, AUTH_CHECK_INTERVAL_MS);
}

function startAuthRecoveryPoller(): void {
	if (authRecoveryTimer) return;
	log("auth watchdog: polling for auth recovery...");

	authRecoveryTimer = setInterval(async () => {
		log("auth watchdog: checking if auth is valid again...");
		const valid = await checkAuthValid();
		if (valid) {
			log("auth watchdog: auth recovered! Restarting daemon...");
			authFailed = false;
			authNotificationSent = false;
			lastAuthCheckOffset = 0;

			// Stop recovery poller
			if (authRecoveryTimer) {
				clearInterval(authRecoveryTimer);
				authRecoveryTimer = null;
			}

			// Truncate the stdout log so old auth errors don't re-trigger
			try {
				writeFileSync(STDOUT_LOG, "");
			} catch {}

			// Notify user
			await sendTelegramNotification("✅ *Claude Telegram daemon: auth recovered*\n\nRestarting the daemon now.");

			// Restart context watchdog and Claude
			startContextWatchdog();
			restartCount = 0;
			startClaude();
		}
	}, AUTH_RECOVERY_CHECK_MS);
}

// ── Context watchdog ──────────────────────────────────────────────
// Monitors the stdout log for context usage percentage.
// When it exceeds CONTEXT_THRESHOLD_PCT, triggers a graceful restart
// to prevent the session from becoming unresponsive.

let contextWatchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchdogTrigger = 0;

function startContextWatchdog(): void {
	if (contextWatchdogTimer) return;
	contextWatchdogTimer = setInterval(() => {
		if (!currentChild || shuttingDown) return;
		// Debounce: don't trigger more than once per 60 seconds
		if (Date.now() - lastWatchdogTrigger < 60_000) return;
		try {
			// Check 1: session running too long (prevents dormancy bug).
			// Runs FIRST and independently of log parsing — the age-based cap must fire
			// even when the stdout log is unparseable (e.g. PTY ANSI escapes swallow the
			// status bar rendering, which is how a 7-day dormant session slipped past).
			const uptime = Date.now() - lastStartTime;
			if (uptime > MAX_SESSION_UPTIME_MS) {
				log(`context watchdog: session uptime ${Math.round(uptime / 60000)}min exceeds max ${Math.round(MAX_SESSION_UPTIME_MS / 60000)}min — triggering restart`);
				lastWatchdogTrigger = Date.now();
				mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
				writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
				return;
			}

			// Read the last 2KB of the stdout log to find the context percentage
			const stat = statSync(STDOUT_LOG);
			const readSize = Math.min(stat.size, 2048);
			const fd = openSync(STDOUT_LOG, "r");
			const buf = Buffer.alloc(readSize);
			readSync(fd, buf, 0, readSize, stat.size - readSize);
			closeSync(fd);
			const tail = buf.toString("utf-8");

			// Match the status bar pattern: ░█ blocks followed by percentage
			// This avoids false positives from message content like "I'm 85% sure"
			const matches = [...tail.matchAll(/[█░]+\s+(\d{1,3})%/g)];
			if (matches.length === 0) return;

			// Take the last percentage found (most recent status bar)
			const lastPct = Number.parseInt(matches[matches.length - 1][1], 10);

			// Check 2: context too high
			if (lastPct >= CONTEXT_THRESHOLD_PCT && lastPct <= 100) {
				log(`context watchdog: usage at ${lastPct}% (threshold: ${CONTEXT_THRESHOLD_PCT}%) — triggering restart`);
				lastWatchdogTrigger = Date.now();
				mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
				writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
				return;
			}
		} catch {
			// Ignore read errors — file might not exist yet
		}
	}, CONTEXT_CHECK_INTERVAL_MS);
}

// Main
// Write pidfile so MCP servers can detect daemon mode
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(PID_FILE, String(process.pid));

log("telegram daemon supervisor starting");
log(`router model: ${ROUTER_MODEL} (set TELEGRAM_ROUTER_MODEL to change)`);
log(`signal file: ${SIGNAL_FILE}`);
log(`claude args: ${[...BASE_ARGS, ...EXTRA_ARGS].join(" ")}`);
startWatching();
startContextWatchdog();
startAuthWatchdog();
void cleanupOrphans().then(() => {
	startClaude();
});
