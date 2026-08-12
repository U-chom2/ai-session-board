import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readTranscriptDetails } from "./claude-hook.mjs";

const PORT = 47832;
const CLAUDE_STATE_DIR = process.env.RUNBOARD_CLAUDE_STATE_DIR || join(dirname(fileURLToPath(import.meta.url)), ".runboard", "claude");

export function isAllowedOrigin(origin) {
  return origin === "http://localhost:47831" || origin === "http://127.0.0.1:47831";
}

function versionedFile(directory, prefix) {
  if (!existsSync(directory)) return null;
  const names = readdirSync(directory)
    .map((name) => [name, name.match(new RegExp(`^${prefix}_(\\d+)\\.sqlite$`))])
    .filter((entry) => entry[1])
    .sort((a, b) => Number(b[1][1]) - Number(a[1][1]));
  return names[0] ? join(directory, names[0][0]) : null;
}

export function discoverCodexHomes(userHome = homedir()) {
  const configured = process.env.RUNBOARD_CODEX_HOMES;
  const candidates = configured
    ? configured.split(":").filter(Boolean)
    : readdirSync(userHome, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\.codex(?:-[\w-]+)?$/.test(entry.name))
        .map((entry) => join(userHome, entry.name));
  return candidates.filter((directory) => versionedFile(directory, "state"));
}

function rowsByThread(database, sql) {
  if (!database) return new Map();
  return new Map(database.prepare(sql).all().map((row) => [row.thread_id, row]));
}

function isPidAlive(pid) {
  pid = Number(pid);
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isProcessAlive(processUuid) {
  return isPidAlive(/^pid:(\d+):/.exec(processUuid ?? "")?.[1]);
}

function activityNote(item, lastMessage, status) {
  if (status !== "IN_PROGRESS" && lastMessage?.text) return cleanText(lastMessage.text);
  if (!item) return "Codexが作業しています";
  if (item.item_type === "commandExecution") return "コマンドを実行しています";
  if (item.item_type === "fileChange") return "ファイルを変更しています";
  if (item.item_type === "webSearch") return "Webで調査しています";
  if (item.item_type === "reasoning") return "方針を整理しています";
  try {
    const text = JSON.parse(item.item_json).text;
    return text ? cleanText(text) : "Codexが作業しています";
  } catch {
    return "Codexが作業しています";
  }
}

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").replace(/[#*_`>]/g, "").trim().slice(0, 180);
}

function displayTime(timestamp, now) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "たった今";
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return new Date(timestamp).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

export function readCodexHome(directory, now = Date.now(), processAlive = isProcessAlive) {
  const statePath = versionedFile(directory, "state");
  if (!statePath) return [];
  const historyPath = versionedFile(directory, "thread_history");
  const logsPath = versionedFile(directory, "logs");
  const state = new DatabaseSync(statePath, { readOnly: true });
  const history = historyPath ? new DatabaseSync(historyPath, { readOnly: true }) : null;
  const logs = logsPath ? new DatabaseSync(logsPath, { readOnly: true }) : null;

  try {
    const turns = rowsByThread(history, `
      SELECT turn_id, thread_id, status, started_at, completed_at
      FROM thread_turns
      WHERE rowid IN (SELECT max(rowid) FROM thread_turns GROUP BY thread_id)
    `);
    const items = rowsByThread(history, `
      SELECT thread_id, item_type, item_json
      FROM thread_items
      WHERE rowid IN (SELECT max(rowid) FROM thread_items GROUP BY thread_id)
    `);
    const messages = rowsByThread(history, `
      SELECT thread_id, json_extract(item_json, '$.text') AS text
      FROM thread_items
      WHERE item_type = 'agentMessage'
        AND rowid IN (SELECT max(rowid) FROM thread_items WHERE item_type = 'agentMessage' GROUP BY thread_id)
    `);
    const closed = rowsByThread(logs, `
      SELECT thread_id, max(ts) AS closed_at
      FROM logs
      WHERE target = 'codex_core::session::handlers'
        AND feedback_log_body LIKE '%Agent loop exited%'
        AND thread_id IS NOT NULL
      GROUP BY thread_id
    `);
    const processes = rowsByThread(logs, `
      SELECT thread_id, process_uuid
      FROM logs
      WHERE thread_id IS NOT NULL AND process_uuid IS NOT NULL
        AND id IN (SELECT max(id) FROM logs WHERE thread_id IS NOT NULL GROUP BY thread_id)
    `);
    const threads = state.prepare(`
      SELECT id, title, preview, cwd, source, archived, created_at_ms, updated_at_ms, thread_source, model, reasoning_effort
      FROM threads
      WHERE thread_source IS NULL OR thread_source = 'user'
      ORDER BY updated_at_ms DESC
      LIMIT 80
    `).all();

    return threads.flatMap((thread) => {
      const turn = turns.get(thread.id);
      if (!turn) return [];
      const updatedAt = Number(thread.updated_at_ms || thread.created_at_ms || 0);
      const closedAt = Number(closed.get(thread.id)?.closed_at || 0) * 1000;
      const processUuid = processes.get(thread.id)?.process_uuid;
      let status = "REVIEW";
      if (thread.archived || closedAt >= updatedAt) status = "DONE";
      else if (processUuid && !processAlive(processUuid)) status = "DONE";
      else if (turn?.status === "inProgress") status = "IN_PROGRESS";

      if (status === "DONE" && updatedAt < now - 24 * 60 * 60 * 1000) return [];
      return [{
        id: `codex:${basename(directory)}:${thread.id}`,
        title: cleanText(thread.title || thread.preview || "無題のセッション").slice(0, 90),
        status,
        agent: "Codex",
        session: thread.id,
        project: basename(thread.cwd) || thread.cwd,
        note: activityNote(items.get(thread.id), messages.get(thread.id), status),
        updated: displayTime(updatedAt, now),
        updatedAt,
        account: basename(directory),
        source: thread.source,
        ...(typeof thread.model === "string" && thread.model.trim() ? { model: thread.model.trim() } : {}),
        ...(typeof thread.reasoning_effort === "string" && thread.reasoning_effort.trim() ? { effort: thread.reasoning_effort.trim() } : {}),
      }];
    });
  } finally {
    state.close();
    history?.close();
    logs?.close();
  }
}

export function readCodexSessions(now = Date.now(), homes = discoverCodexHomes()) {
  return homes
    .flatMap((directory) => {
      try {
        return readCodexHome(directory, now);
      } catch (error) {
        console.error(`[collector] ${directory}: ${error.message}`);
        return [];
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeClaudeState(state, stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, `${state.session}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function bootstrapClaudeSessions(now = Date.now(), stateDir = CLAUDE_STATE_DIR, historyPath = join(homedir(), ".claude", "history.jsonl"), claudeHome = join(homedir(), ".claude")) {
  if (!existsSync(historyPath)) return;
  const recent = new Map();
  for (const line of readFileSync(historyPath, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.sessionId || Number(entry.timestamp) < now - 24 * 60 * 60 * 1000) continue;
      const current = recent.get(entry.sessionId) || { ...entry, title: "", note: "" };
      const message = cleanText(String(entry.display ?? "").replace(/^\/[\w-]+\s*/, ""));
      if (message && !current.title) current.title = message.slice(0, 90);
      if (message) current.note = message;
      current.timestamp = Math.max(Number(current.timestamp || 0), Number(entry.timestamp || 0));
      recent.set(entry.sessionId, current);
    } catch { /* ignore malformed history lines */ }
  }

  for (const entry of recent.values()) {
    const statePath = join(stateDir, `${entry.sessionId}.json`);
    const transcriptPath = join(claudeHome, "projects", String(entry.project || "").replaceAll(/[^A-Za-z0-9]/g, "-"), `${entry.sessionId}.jsonl`);
    const details = readTranscriptDetails(transcriptPath);
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        if ((!state.model && details.model) || (!state.effort && details.effort)) {
          writeClaudeState({ ...state, ...(state.model ? {} : { model: details.model }), ...(state.effort ? {} : { effort: details.effort }) }, stateDir);
        }
      } catch { /* ignore malformed hook state */ }
      continue;
    }
    writeClaudeState({
      session: entry.sessionId,
      title: entry.title || "Claude Code session",
      status: "DONE",
      agent: "Claude Code",
      cwd: entry.project || "",
      project: basename(entry.project || "") || "Claude Code",
      note: entry.note || "過去のClaude Codeセッション",
      updatedAt: entry.timestamp,
      account: ".claude",
      pid: null,
      ...(details.model ? { model: details.model } : {}),
      ...(details.effort ? { effort: details.effort } : {}),
    }, stateDir);
  }
}

export function readClaudeSessions(now = Date.now(), stateDir = CLAUDE_STATE_DIR, processAlive = isPidAlive) {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const state = JSON.parse(readFileSync(join(stateDir, name), "utf8"));
        if (!["IN_PROGRESS", "REVIEW", "DONE"].includes(state.status)) return [];
        const updatedAt = Number(state.updatedAt || 0);
        const status = state.status !== "DONE" && state.pid && !processAlive(state.pid) ? "DONE" : state.status;
        if (status === "DONE" && updatedAt < now - 24 * 60 * 60 * 1000) return [];
        return [{
          id: `claude:.claude:${state.session}`,
          title: cleanText(state.title || "Claude Code session").slice(0, 90),
          status,
          agent: "Claude Code",
          session: state.session,
          project: state.project || basename(state.cwd || "") || "Claude Code",
          note: cleanText(state.note || "Claude Code session"),
          updated: displayTime(updatedAt, now),
          updatedAt,
          account: state.account || ".claude",
          source: "claude-code",
          ...(typeof state.model === "string" && state.model.trim() ? { model: state.model.trim() } : {}),
          ...(typeof state.effort === "string" && state.effort.trim() ? { effort: state.effort.trim() } : {}),
        }];
      } catch {
        return [];
      }
    });
}

export function readAllSessions(now = Date.now()) {
  return [...readCodexSessions(now), ...readClaudeSessions(now)].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function startCollector(port = PORT) {
  try { bootstrapClaudeSessions(); } catch (error) { console.error(`[collector] Claude bootstrap: ${error.message}`); }
  return createServer((request, response) => {
    const origin = request.headers.origin ?? "";
    if (isAllowedOrigin(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" || request.url !== "/api/sessions") {
      response.writeHead(404).end("Not found");
      return;
    }
    const sessions = readAllSessions();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ sessions, syncedAt: Date.now() }));
  }).listen(port, "127.0.0.1", () => {
    console.log(`[collector] Codex + Claude Code sessions: http://127.0.0.1:${port}/api/sessions`);
  });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) startCollector();
