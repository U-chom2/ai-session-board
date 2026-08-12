# ai-session-board

Codex CLI と Claude Code のローカルセッションを、`TODO → IN PROGRESS ⇄ REVIEW → DONE` で確認する小さなボードです。APIキーを登録せず、手元のセッション情報だけを読み取って動作します。

## 画面

- 4列のステータスボードで、作業中・確認待ち・完了を一覧表示
- フッターにエージェント、モデル、thinking/reasoning effort（例: `CODEX · gpt-5.6-sol · xhigh`）を表示
- セッションの現在の作業、コメント、手動メモを確認・編集
- `DONEへ` で手動完了にでき、新しい活動があれば自動同期で戻ります

## 必要なもの

- Node.js `>=22.13.0`
- Codex CLI または Claude Code の少なくとも一方

公式ドキュメント: [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) / [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started)

## セットアップ

```bash
git clone https://github.com/OKUMURA-X/ai-session-board.git
cd ai-session-board
npm ci
npm run install:claude-hooks # Claude Codeを使う場合だけ（任意）
npm run dev
```

ブラウザで http://localhost:47831 を開きます。画面は47831、読み取り専用collectorは127.0.0.1:47832で起動します。

Claude Code hookを削除する場合:

```bash
npm run uninstall:claude-hooks
```

インストーラーは `~/.claude/settings.json` をアトミックに更新し、Runboard自身のcommandだけを追加・削除します。既存の無関係なhookやhook groupは保持します。設定ファイルがない場合は親ディレクトリと0600の設定ファイルを作成します。

## データの流れ

collectorは `~/.codex*` のSQLiteを読み取り専用で参照し、Claude Codeではhookがローカルのセッション要約を `.runboard/claude` に保存します。モデルとeffortはCodexのthread情報、またはClaude transcript末尾256KBから取得します。TODO・コメント・手動DONEはブラウザのlocalStorageに保存されます。

外部API呼び出し、テレメトリー、アプリからの送信処理はありません。collectorは127.0.0.1にのみbindし、画面のCORSもlocalhost/127.0.0.1の47831に限定しています。タイトル・パス・コメントには機密情報が含まれる可能性があるため、画面共有時は注意してください。ポートを公開したり、ホストされたUIとしてデプロイしたりしないでください。

本番依存だけの監査は `npm audit --omit=dev` で確認できます。脆弱性を見つけた場合は、公開Issueではなく[Security Policy](SECURITY.md)の手順で報告してください。

## 設定と制限

Codexの保存場所を明示する場合は、コロン区切りで設定します。

```bash
RUNBOARD_CODEX_HOMES="$HOME/.codex:$HOME/.codex-work" npm run dev
```

macOSとLinuxを対象にしています（開発時の確認環境はmacOS）。Codex/Claude CodeのローカルSQLite・JSONL・hook schemaは将来変更される可能性があります。Claude hookのインストールには `~/.claude/settings.json` の変更権限が必要です。

## 開発

```bash
npm test
npm run lint
git diff --check
```

## License

[MIT](LICENSE)
