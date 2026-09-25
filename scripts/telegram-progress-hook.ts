#!/usr/bin/env bun
/**
 * Claude Code hook for Agentic Mode. Installed by supervisor.ts via --settings
 * for PreToolUse, PostToolUse and Stop, so it only runs inside the daemon session.
 *
 * Appends one JSON line per event to ~/.claude/channels/telegram/data/progress.jsonl.
 * server.ts tails that file and edits a live "Working..." message in the chat
 * that started the turn. Must stay fast and must never fail the tool call:
 * every error is swallowed and the hook always exits 0 with no output.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";

const DATA_DIR = join(userInfo().homedir || homedir(), ".claude", "channels", "telegram", "data");
const PROGRESS_FILE = join(DATA_DIR, "progress.jsonl");

// The telegram plugin's own tools (reply, react, edit_message, ...) are the
// conversation itself, not background work.
const SKIP_PREFIXES = ["mcp__plugin_telegram", "mcp__telegram"];

function clip(s: unknown, n: number): string {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// short = verbosity 1, long = verbosity 2
function describe(tool: string, input: Record<string, unknown>): { short: string; long: string } {
	const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
	switch (tool) {
		case "Read":
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return { short: file ? basename(file) : "", long: file ?? "" };
		case "Bash":
			return { short: clip(input.description ?? input.command, 50), long: clip(input.command, 160) };
		case "Grep":
			return { short: clip(input.pattern, 40), long: clip(`${input.pattern} ${input.path ?? ""}`, 160) };
		case "Glob":
			return { short: clip(input.pattern, 40), long: clip(`${input.pattern} ${input.path ?? ""}`, 160) };
		case "WebFetch":
			return { short: clip(input.url, 50), long: clip(input.url, 160) };
		case "WebSearch":
			return { short: clip(input.query, 50), long: clip(input.query, 160) };
		case "Agent":
		case "Task":
			return { short: clip(input.description, 50), long: clip(input.prompt, 160) };
		case "Skill":
			return { short: clip(input.skill, 40), long: clip(`${input.skill} ${input.args ?? ""}`, 160) };
		default:
			return { short: "", long: clip(JSON.stringify(input), 160) };
	}
}

try {
	const raw = await Bun.stdin.text();
	const ev = JSON.parse(raw) as {
		hook_event_name?: string;
		tool_name?: string;
		tool_input?: Record<string, unknown>;
		session_id?: string;
		transcript_path?: string;
	};
	const tp = ev.transcript_path;
	let line: Record<string, unknown> | null = null;
	const tool = ev.tool_name;
	const own = tool !== undefined && SKIP_PREFIXES.some((p) => tool.startsWith(p));
	if (ev.hook_event_name === "Stop") {
		line = { t: Date.now(), type: "stop", session: ev.session_id, tp };
	} else if (ev.hook_event_name === "PreToolUse" && tool && !own) {
		line = { t: Date.now(), type: "tool", tool, ...describe(tool, ev.tool_input ?? {}), session: ev.session_id, tp };
	} else if (ev.hook_event_name === "PostToolUse" && tool && !own) {
		line = { t: Date.now(), type: "tool_done", tool, session: ev.session_id, tp };
	}
	if (line) {
		mkdirSync(DATA_DIR, { recursive: true });
		appendFileSync(PROGRESS_FILE, `${JSON.stringify(line)}\n`);
	}
} catch {
	// Never block or fail the tool call.
}
process.exit(0);
