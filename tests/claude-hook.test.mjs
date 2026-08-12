import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleClaudeHook, readTranscriptDetails } from "../claude-hook.mjs";
import { bootstrapClaudeSessions, readClaudeSessions } from "../collector.mjs";

test("reads model and effort from the tail of a long assistant JSONL entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-claude-transcript-"));
  const transcriptPath = join(directory, "session.jsonl");
  try {
    const text = `${"x".repeat(256 * 1024)} \\"model\\":\\"fake-model\\" \\"effort\\":\\"fake-effort\\"`;
    writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", message: { content: [{ text }], model: "claude-fable-5" }, effort: "medium" })}\n`);
    assert.deepEqual(readTranscriptDetails(transcriptPath), { model: "claude-fable-5", effort: "medium" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("maps Claude Code hooks to board statuses", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-claude-"));
  const session = "11111111-2222-4333-8444-555555555555";
  const transcriptPath = join(directory, `${session}.jsonl`);
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5" }, effort: "medium" })}\n`);
  const event = (hook_event_name, extra = {}) => ({ session_id: session, cwd: "/workspace/demo", hook_event_name, transcript_path: transcriptPath, ...extra });
  try {
    assert.equal(handleClaudeHook(event("SessionStart", { source: "startup" }), directory, 123), null);
    assert.equal(existsSync(join(directory, `${session}.json`)), false);
    assert.equal(handleClaudeHook(event("UserPromptSubmit", { prompt: "認証画面を直して" }), directory, 123).status, "IN_PROGRESS");
    assert.equal(handleClaudeHook(event("PreToolUse", { tool_name: "Edit" }), directory, 123).note, "ファイルを変更しています");
    assert.equal(handleClaudeHook(event("Notification", { notification_type: "permission_prompt" }), directory, 123).status, "REVIEW");
    assert.equal(handleClaudeHook(event("Stop", { last_assistant_message: "修正したので確認してください" }), directory, 123).status, "REVIEW");
    assert.equal(handleClaudeHook(event("SessionEnd", { reason: "prompt_input_exit" }), directory, 123).status, "DONE");

    const state = JSON.parse(readFileSync(join(directory, `${session}.json`), "utf8"));
    assert.equal(state.title, "認証画面を直して");
    assert.equal(state.model, "claude-sonnet-5");
    assert.equal(state.effort, "medium");
    assert.equal(readClaudeSessions(Date.now(), directory)[0].agent, "Claude Code");
    assert.equal(readClaudeSessions(Date.now(), directory)[0].model, "claude-sonnet-5");
    assert.equal(readClaudeSessions(Date.now(), directory)[0].effort, "medium");
    assert.equal(readClaudeSessions(state.updatedAt + 24 * 60 * 60 * 1000 + 1, directory).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bootstraps a Claude transcript model from history", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-claude-bootstrap-"));
  const stateDir = join(directory, "state");
  const claudeHome = join(directory, "claude");
  const session = "22222222-3333-4444-8555-666666666666";
  const project = "/Users/demo/workspace/hire_copilot.mock";
  const transcriptDir = join(claudeHome, "projects", "-Users-demo-workspace-hire-copilot-mock");
  const historyPath = join(directory, "history.jsonl");
  try {
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(historyPath, `${JSON.stringify({ sessionId: session, project, timestamp: 1_800_000_000_000, display: "調査" })}\n`);
    writeFileSync(join(transcriptDir, `${session}.jsonl`), `${JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5" }, effort: "medium" })}\n`);
    bootstrapClaudeSessions(1_800_000_000_000, stateDir, historyPath, claudeHome);
    const state = JSON.parse(readFileSync(join(stateDir, `${session}.json`), "utf8"));
    assert.equal(state.model, "claude-sonnet-5");
    assert.equal(state.effort, "medium");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
