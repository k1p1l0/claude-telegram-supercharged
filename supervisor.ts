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
	rmSync,
	statSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), ".claude", "channels", "telegram");
const DATA_DIR = join(STATE_DIR, "data");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");
const CLAUDE_CMD = "claude";
// Router model: configurable via TELEGRAM_ROUTER_MODEL env var.
// Options: "haiku" (fast, 200K context), "sonnet" (balanced, 1M context), "opus" (deep, 1M context)
// Default: "sonnet" — best balance of speed and context window.
const ROUTER_MODEL = process.env.TELEGRAM_ROUTER_MODEL || "sonnet";
const BASE_ARGS = [
	"--channels",
	"plugin:telegram@claude-plugins-official",
	"--dangerously-skip-permissions",
	"--model",
	ROUTER_MODEL,
];

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
// Delay before restart to let Claude finish sending Telegram replies
const RESTART_DELAY_MS = 3_000;

let currentChild: ChildProcess | null = null;
let restartCount = 0;
let lastStartTime = 0;
let shuttingDown = false;
let pendingRestart = false;

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
	const args = [...BASE_ARGS, ...EXTRA_ARGS];
	log(`spawning: ${CLAUDE_CMD} ${args.join(" ")}`);
	// Use `expect` wrapper to allocate a PTY and auto-accept the workspace trust dialog.
	// expect spawns Claude with a pseudo-TTY (so it enters interactive mode under launchd)
	// and auto-sends Enter when it sees the "trust this folder" prompt.
	const EXPECT_WRAPPER = join(homedir(), ".claude", "scripts", "claude-daemon-wrapper.exp");
	const child = spawn(EXPECT_WRAPPER, args, {
		stdio: "inherit",
		env: { ...process.env },
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

	if (currentChild) {
		await killChild(currentChild);
	}
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Kill any orphaned claude --channels telegram processes from previous runs
async function cleanupOrphans(): Promise<void> {
	const { execSync } = await import("node:child_process");
	try {
		const myPid = process.pid;
		// Find claude processes with telegram channel flag, excluding our own PID
		const result = execSync(
			`pgrep -f 'claude.*--channels.*telegram' || true`,
			{ encoding: "utf-8" },
		).trim();
		if (!result) return;

		const pids = result
			.split("\n")
			.map((p) => Number.parseInt(p.trim(), 10))
			.filter((p) => !Number.isNaN(p) && p !== myPid);

		// Filter out interactive sessions (processes with a TTY are user terminals)
		const orphanPids: number[] = [];
		for (const pid of pids) {
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

			// Check 1: context too high
			if (lastPct >= CONTEXT_THRESHOLD_PCT && lastPct <= 100) {
				log(`context watchdog: usage at ${lastPct}% (threshold: ${CONTEXT_THRESHOLD_PCT}%) — triggering restart`);
				lastWatchdogTrigger = Date.now();
				mkdirSync(join(SIGNAL_FILE, ".."), { recursive: true });
				writeFileSync(SIGNAL_FILE, String(Date.now() + 2000));
				return;
			}

			// Check 2: session running too long (prevents dormancy bug)
			const uptime = Date.now() - lastStartTime;
			if (uptime > MAX_SESSION_UPTIME_MS) {
				log(`context watchdog: session uptime ${Math.round(uptime / 60000)}min exceeds max ${Math.round(MAX_SESSION_UPTIME_MS / 60000)}min — triggering restart`);
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
log("telegram daemon supervisor starting");
log(`router model: ${ROUTER_MODEL} (set TELEGRAM_ROUTER_MODEL to change)`);
log(`signal file: ${SIGNAL_FILE}`);
log(`claude args: ${[...BASE_ARGS, ...EXTRA_ARGS].join(" ")}`);
startWatching();
startContextWatchdog();
void cleanupOrphans().then(() => {
	startClaude();
});
