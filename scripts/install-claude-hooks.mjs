import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const settingsPath = process.env.CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
const hookPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "claude-hook.mjs");
const command = `node "${hookPath}"`;
const events = ["UserPromptSubmit", "PreToolUse", "Notification", "Stop", "SessionEnd"];

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function removeRunboardHooks(settings) {
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((hook) => hook.command !== command);
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
}

function writeSettings(settings, mode = 0o600) {
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  renameSync(temporary, settingsPath);
}

function install() {
  const settings = readSettings();
  const mode = existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : 0o600;
  settings.hooks ||= {};
  removeRunboardHooks(settings);
  for (const event of events) settings.hooks[event] = [...(settings.hooks[event] ?? []), { hooks: [{ type: "command", command, timeout: 5 }] }];
  writeSettings(settings, mode);
  console.log(`Runboard hooks installed in ${settingsPath}`);
}

function uninstall() {
  const settings = readSettings();
  removeRunboardHooks(settings);
  writeSettings(settings, existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : 0o600);
  console.log(`Runboard hooks removed from ${settingsPath}`);
}

if (process.argv.includes("--uninstall")) uninstall();
else install();
