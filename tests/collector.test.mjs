import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { isAllowedOrigin, readCodexHome } from "../collector.mjs";

test("allows only the local board origins", () => {
  assert.equal(isAllowedOrigin("http://localhost:47831"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:47831"), true);
  assert.equal(isAllowedOrigin("http://localhost:47832"), false);
  assert.equal(isAllowedOrigin("http://evil.local:47831"), false);
});

test("maps Codex lifecycle records to board statuses", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-codex-"));
  const now = 1_800_000_000_000;
  const state = new DatabaseSync(join(directory, "state_5.sqlite"));
  const history = new DatabaseSync(join(directory, "thread_history_1.sqlite"));
  const logs = new DatabaseSync(join(directory, "logs_2.sqlite"));
  try {
    state.exec(`CREATE TABLE threads (
      id TEXT, title TEXT, preview TEXT, cwd TEXT, source TEXT, archived INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, model TEXT, reasoning_effort TEXT
    )`);
    history.exec("CREATE TABLE thread_turns (turn_id TEXT, thread_id TEXT, status TEXT, started_at INTEGER, completed_at INTEGER)");
    history.exec("CREATE TABLE thread_items (thread_id TEXT, item_type TEXT, item_json TEXT)");
    logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, target TEXT, feedback_log_body TEXT, thread_id TEXT, process_uuid TEXT)");

    const insertThread = state.prepare("INSERT INTO threads VALUES (?, ?, '', ?, 'cli', 0, ?, ?, NULL, ?, ?)");
    for (const [id, title] of [["wait", "指示待ち"], ["work", "実装中"], ["review", "確認待ち"], ["done", "終了済み"], ["dead", "終了イベントなし"]]) {
      insertThread.run(id, title, `/workspace/${id}`, now - 1_000, now - 1_000, id === "work" ? "gpt-5.6-sol" : null, id === "work" ? "xhigh" : null);
    }
    const insertTurn = history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)");
    insertTurn.run("t1", "work", "inProgress", now / 1000, null);
    insertTurn.run("t2", "review", "completed", now / 1000, now / 1000);
    insertTurn.run("t3", "done", "completed", now / 1000, now / 1000);
    insertTurn.run("t4", "dead", "completed", now / 1000, now / 1000);
    history.prepare("INSERT INTO thread_items VALUES (?, ?, ?)").run("work", "fileChange", "{}");
    logs.prepare("INSERT INTO logs (ts, target, feedback_log_body, thread_id, process_uuid) VALUES (?, ?, ?, ?, ?)").run(
      now / 1000,
      "codex_core::session::handlers",
      "Agent loop exited",
      "done",
      "pid:1:done",
    );
    logs.prepare("INSERT INTO logs (ts, target, feedback_log_body, thread_id, process_uuid) VALUES (?, '', '', ?, ?)").run(now / 1000, "dead", "pid:404:dead");

    const sessions = readCodexHome(directory, now, (processUuid) => !processUuid.includes(":404:"));
    const statuses = Object.fromEntries(sessions.map((session) => [session.session, session.status]));
    assert.deepEqual(statuses, { work: "IN_PROGRESS", review: "REVIEW", done: "DONE", dead: "DONE" });
    assert.equal(sessions.find((session) => session.session === "work").note, "ファイルを変更しています");
    assert.equal(sessions.find((session) => session.session === "work").model, "gpt-5.6-sol");
    assert.equal(sessions.find((session) => session.session === "work").effort, "xhigh");
    assert.equal(readCodexHome(directory, now + 24 * 60 * 60 * 1000 + 1_001, () => false).some((session) => session.status === "DONE"), false);
  } finally {
    state.close();
    history.close();
    logs.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
