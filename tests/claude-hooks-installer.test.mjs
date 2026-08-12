import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(root, "scripts", "install-claude-hooks.mjs");
const command = `node "${join(root, "claude-hook.mjs")}"`;
const events = ["UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];

function run(settingsPath, ...args) {
  execFileSync(process.execPath, [installer, ...args], {
    env: { ...process.env, CLAUDE_SETTINGS_PATH: settingsPath },
    stdio: "pipe",
  });
}

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("installs atomically into missing settings and is idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-hooks-"));
  const settingsPath = join(directory, "claude", "settings.json");
  try {
    run(settingsPath);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    run(settingsPath);
    const settings = read(settingsPath);
    for (const event of events) {
      const matches = settings.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command === command);
      assert.equal(matches.length, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves unrelated hooks and removes only Runboard hooks", () => {
  const directory = mkdtempSync(join(tmpdir(), "runboard-hooks-"));
  const settingsPath = join(directory, "settings.json");
  const unrelated = { type: "command", command: "node unrelated.mjs" };
  try {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {
      UserPromptSubmit: [{ matcher: "*", hooks: [unrelated] }],
      CustomEvent: [{ hooks: [{ type: "command", command }] }, { hooks: [unrelated] }],
    }}));
    chmodSync(settingsPath, 0o640);
    run(settingsPath);
    let settings = read(settingsPath);
    assert.deepEqual(settings.hooks.UserPromptSubmit[0].hooks, [unrelated]);
    assert.equal(settings.hooks.CustomEvent.length, 1);
    assert.deepEqual(settings.hooks.CustomEvent[0].hooks, [unrelated]);
    run(settingsPath, "--uninstall");
    settings = read(settingsPath);
    assert.deepEqual(settings, { hooks: {
      UserPromptSubmit: [{ matcher: "*", hooks: [unrelated] }],
      CustomEvent: [{ hooks: [unrelated] }],
    }});
    assert.equal(statSync(settingsPath).mode & 0o777, 0o640);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
