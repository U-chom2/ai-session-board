import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultStateDir = join(dirname(fileURLToPath(import.meta.url)), ".runboard", "claude");

function clean(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").replace(/[#*_`>]/g, "").trim().slice(0, limit);
}

export function readTranscriptDetails(transcriptPath) {
  if (!transcriptPath) return {};
  let fd;
  try {
    const size = statSync(transcriptPath).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fd = openSync(transcriptPath, "r");
    readSync(fd, buffer, 0, length, size - length);
    // ponytail: scan only the transcript tail; an unusually huge final JSONL entry may need a larger window.
    const content = buffer.toString("utf8");
    const fields = /(?<!\\)"(model|effort)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
    let match;
    const details = {};
    while ((match = fields.exec(content))) {
      try {
        const value = JSON.parse(`"${match[2]}"`);
        if (typeof value === "string" && value.trim()) details[match[1]] = value.trim();
      } catch { /* ignore malformed field values */ }
    }
    return details;
  } catch { /* transcript may disappear while Claude exits */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return {};
}

function toolNote(input) {
  if (["Edit", "Write", "NotebookEdit"].includes(input.tool_name)) return "ファイルを変更しています";
  if (["Read", "Glob", "Grep"].includes(input.tool_name)) return "コードやファイルを調べています";
  if (["WebSearch", "WebFetch"].includes(input.tool_name)) return "Webで調査しています";
  if (["Task", "Agent"].includes(input.tool_name)) return "サブエージェントを動かしています";
  if (input.tool_name === "Bash") return "コマンドを実行しています";
  return `${clean(input.tool_name, 50) || "ツール"}を実行しています`;
}

function findClaudePid() {
  let pid = process.ppid;
  for (let depth = 0; pid > 1 && depth < 5; depth += 1) {
    const result = spawnSync("/bin/ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { encoding: "utf8" });
    const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    if (/claude/i.test(match[2])) return pid;
    pid = Number(match[1]);
  }
  return null;
}

export function handleClaudeHook(input, stateDir = process.env.RUNBOARD_CLAUDE_STATE_DIR || defaultStateDir, pid = findClaudePid()) {
  const session = input.session_id;
  if (!/^[\w-]{6,100}$/.test(session ?? "")) return null;
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, `${session}.json`);
  let previous = {};
  try { previous = JSON.parse(readFileSync(path, "utf8")); } catch { /* first event for this session */ }

  let status;
  let title = previous.title;
  let note;
  switch (input.hook_event_name) {
    case "UserPromptSubmit":
      status = "IN_PROGRESS";
      title = clean(input.prompt, 90) || title;
      note = `指示を受け取りました: ${clean(input.prompt)}`;
      break;
    case "PreToolUse":
      status = "IN_PROGRESS";
      note = toolNote(input);
      break;
    case "Notification":
      if (!["permission_prompt", "idle_prompt"].includes(input.notification_type)) return null;
      status = "REVIEW";
      note = input.notification_type === "permission_prompt" ? "実行許可を待っています" : "ユーザーの確認を待っています";
      break;
    case "Stop":
      status = "REVIEW";
      note = clean(input.last_assistant_message) || "作業が一区切りしました。確認を待っています";
      break;
    case "SessionEnd":
      status = "DONE";
      note = `セッション終了: ${clean(input.reason, 60) || "other"}`;
      break;
    default:
      return null;
  }

  const state = {
    ...previous,
    session,
    title: title || "Claude Code session",
    status,
    agent: "Claude Code",
    cwd: input.cwd || previous.cwd || "",
    project: input.cwd ? input.cwd.split("/").filter(Boolean).at(-1) : previous.project || "Claude Code",
    note,
    updatedAt: Date.now(),
    account: ".claude",
    pid: pid || previous.pid || null,
  };
  const details = readTranscriptDetails(input.transcript_path);
  const model = details.model || previous.model;
  const effort = details.effort || previous.effort;
  if (model) state.model = model;
  if (effort) state.effort = effort;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return state;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    try { handleClaudeHook(JSON.parse(body)); } catch { /* hooks must never block Claude Code */ }
  });
}
