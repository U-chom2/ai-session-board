import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the AI session sprint board", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Runboard — AI Session Sprint<\/title>/i);
  assert.match(html, /Session Sprint/);
  assert.match(html, /IN PROGRESS/);
  assert.match(html, /AI sessions tracked/);
  assert.match(html, /Claude Code/);
  assert.match(html, /3秒ごとに自動同期/);
  assert.doesNotMatch(html, /メインメニュー|aria-label="履歴"|aria-label="設定"/);
  assert.doesNotMatch(html, /codex-preview|Building your site/);
});

test("removes starter preview code and dependency", async () => {
  const packageJson = await readFile(new URL("package.json", root), "utf8");
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview", root)));
});

test("keeps TODOs as editable local memos without sample cards", async () => {
  const page = await readFile(new URL("app/page.tsx", root), "utf8");
  assert.doesNotMatch(page, /function move|AIに渡す|候補者リサーチの精度を改善/);
  assert.match(page, />編集</);
  assert.match(page, />削除</);
  assert.match(page, /runboard:manual-done/);
  assert.match(page, />DONEへ</);
  assert.match(page, /ticket\.effort \? ` · \$\{ticket\.effort\}`/);
});

test("uses dedicated local ports", async () => {
  const [page, collector, dev] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("collector.mjs", root), "utf8"),
    readFile(new URL("scripts/dev.mjs", root), "utf8"),
  ]);
  assert.match(page, /127\.0\.0\.1:47832/);
  assert.match(collector, /PORT = 47832/);
  assert.match(dev, /"--port", "47831"/);
});
