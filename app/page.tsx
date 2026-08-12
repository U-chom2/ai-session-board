"use client";

import { FormEvent, useEffect, useState } from "react";

const columns = [
  { id: "TODO", label: "TODO", hint: "やりたいことメモ", tone: "slate" },
  { id: "IN_PROGRESS", label: "IN PROGRESS", hint: "AIが作業中", tone: "blue" },
  { id: "REVIEW", label: "REVIEW", hint: "確認・修正の往復", tone: "violet" },
  { id: "DONE", label: "DONE", hint: "セッション終了", tone: "green" },
] as const;

type Status = (typeof columns)[number]["id"];
type Agent = "Codex" | "Claude Code" | "Memo";
type Ticket = {
  id: string;
  title: string;
  status: Status;
  agent: Agent;
  session?: string;
  project: string;
  note: string;
  updated: string;
  updatedAt?: number;
  account?: string;
  model?: string;
  effort?: string;
};

const MANUAL_DONE_KEY = "runboard:manual-done";

function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function readTodos(): Ticket[] {
  return readLocal<Ticket[]>("runboard:todos", [])
    .filter((ticket) => !["todo-1", "todo-2", "todo-3"].includes(ticket.id))
    .map((ticket) => ({ ...ticket, status: "TODO" as const }));
}

function readManualDone(): Record<string, number> {
  return readLocal<Record<string, number>>(MANUAL_DONE_KEY, {});
}

function applyManualDone(sessions: Ticket[]): Ticket[] {
  const manualDone = readManualDone();
  let changed = false;
  const next = sessions.map((session) => {
    const markedAt = manualDone[session.id];
    if (markedAt === undefined) return session;
    if (session.updatedAt !== undefined && session.updatedAt > markedAt) {
      delete manualDone[session.id];
      changed = true;
      return session;
    }
    return { ...session, status: "DONE" as const };
  });
  if (changed) localStorage.setItem(MANUAL_DONE_KEY, JSON.stringify(manualDone));
  return next;
}

export default function Home() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [connected, setConnected] = useState(false);
  const [syncedAt, setSyncedAt] = useState("接続中…");
  const selected = tickets.find((ticket) => ticket.id === selectedId);
  const sessions = tickets.filter((ticket) => ticket.agent !== "Memo");
  const codexCount = sessions.filter((ticket) => ticket.agent === "Codex").length;
  const claudeCount = sessions.filter((ticket) => ticket.agent === "Claude Code").length;
  const count = (status: Status) => tickets.filter((ticket) => ticket.status === status).length;

  useEffect(() => {
    let active = true;
    const localTimer = window.setTimeout(() => { if (active) setTickets(readTodos()); }, 0);

    async function refresh() {
      try {
        const response = await fetch("http://127.0.0.1:47832/api/sessions", { cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as { sessions: Ticket[]; syncedAt: number };
        const notes = readLocal<Record<string, string>>("runboard:notes", {});
        if (!active) return;
        setTickets(() => [
          ...readTodos(),
          ...applyManualDone(data.sessions.map((session) => ({ ...session, note: notes[session.id] ?? session.note }))),
        ]);
        setConnected(true);
        setSyncedAt(new Date(data.syncedAt).toLocaleTimeString("ja-JP"));
      } catch {
        if (active) {
          setConnected(false);
          setSyncedAt("collector未接続");
        }
      }
    }

    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearTimeout(localTimer); window.clearInterval(timer); };
  }, []);

  function persistTodos(items: Ticket[]) {
    localStorage.setItem("runboard:todos", JSON.stringify(items.filter((item) => item.agent === "Memo")));
  }

  function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    setTickets((items) => {
      const next = [{
        id: `todo-${Date.now()}`,
        title,
        status: "TODO" as Status,
        agent: "Memo" as Agent,
        project: "Inbox",
        note: "",
        updated: "たった今",
      }, ...items];
      persistTodos(next);
      return next;
    });
    setAdding(false);
  }

  function selectTicket(ticket: Ticket) {
    setSelectedId(ticket.id);
    setDraftTitle(ticket.title);
    setDraft(ticket.note);
  }

  function deleteTodo(id: string) {
    setTickets((items) => {
      const next = items.filter((item) => item.id !== id);
      persistTodos(next);
      return next;
    });
    if (selectedId === id) setSelectedId("");
  }

  function markSessionDone(id: string) {
    const ticket = tickets.find((item) => item.id === id);
    if (!ticket || ticket.agent === "Memo") return;
    const manualDone = readManualDone();
    manualDone[id] = ticket.updatedAt ?? Date.now();
    localStorage.setItem(MANUAL_DONE_KEY, JSON.stringify(manualDone));
    setTickets((items) => items.map((item) => item.id === id ? { ...item, status: "DONE" } : item));
  }

  function saveTicket() {
    const note = draft.trim();
    const title = draftTitle.trim();
    if (!selected || (selected.agent === "Memo" && !title)) return;
    setTickets((items) => {
      const next = items.map((item) => item.id === selectedId
        ? { ...item, title: selected.agent === "Memo" ? title : item.title, note, updated: "たった今" }
        : item);
      if (selected.agent === "Memo") persistTodos(next);
      return next;
    });
    if (selected.agent !== "Memo") {
      const notes = readLocal<Record<string, string>>("runboard:notes", {});
      localStorage.setItem("runboard:notes", JSON.stringify({ ...notes, [selectedId]: note }));
    }
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div className="brand">
            <div className="logo" aria-label="Runboard">R</div>
            <div>
              <div className="eyebrow"><span className={`live-dot ${connected ? "" : "offline"}`} /> {connected ? "LIVE WORKSPACE" : "CONNECTING"}</div>
              <h1>Session Sprint</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="agent-summary">
              <span><b>{count("IN_PROGRESS")}</b> working</span>
              <span><b>{count("REVIEW")}</b> review</span>
            </div>
            <button className="primary-button" onClick={() => setAdding(true)}><span>＋</span> TODOを追加</button>
          </div>
        </header>

        <section className="pulse-strip" aria-label="稼働状況">
          <div className="pulse-copy">
            <span className="pulse-mark">●</span>
            <div>
              <strong>{sessions.length} AI sessions tracked</strong>
              <small>Codex {codexCount} · Claude Code {claudeCount} · 3秒ごとに自動同期</small>
            </div>
          </div>
          <div className="activity-line" aria-hidden="true">
            {Array.from({ length: 32 }, (_, index) => <i key={index} />)}
          </div>
          <time>最終同期 {syncedAt}</time>
        </section>

        {adding && (
          <form className="quick-add" onSubmit={addTodo}>
            <span>NEW TODO</span>
            <input name="title" placeholder="AIにやってほしいことをメモ…" aria-label="TODOの内容" />
            <button type="submit">追加</button>
            <button type="button" className="cancel" onClick={() => setAdding(false)}>キャンセル</button>
          </form>
        )}

        <div className="board" aria-label="AIセッションボード">
          {columns.map((column) => {
            const items = tickets.filter((ticket) => ticket.status === column.id);
            return (
              <section className={`column ${column.tone}`} key={column.id}>
                <header className="column-header">
                  <div><span className="status-dot" /><h2>{column.label}</h2><b>{items.length}</b></div>
                  <p>{column.hint}</p>
                </header>
                <div className="ticket-list">
                  {items.map((ticket) => (
                    <article className={`ticket ${selectedId === ticket.id ? "selected" : ""} ${ticket.status === "DONE" ? "complete" : ""}`} key={ticket.id}>
                      <button
                        className="ticket-body"
                        onClick={() => selectTicket(ticket)}
                        aria-label={`${ticket.title}の詳細`}
                      >
                        <div className="ticket-topline">
                          <span className="project">{ticket.project}</span>
                          <span className="updated">{ticket.updated}</span>
                        </div>
                        <h3>{ticket.title}</h3>
                        {ticket.agent !== "Memo" && (
                          <div className="session">
                            <span className={`agent-icon ${ticket.agent === "Codex" ? "codex" : "claude"}`}>{ticket.agent === "Codex" ? "C" : "A"}</span>
                            <div><strong>{ticket.agent} <em>{ticket.account}</em></strong><code>{ticket.session}</code></div>
                            {ticket.status === "IN_PROGRESS" && <i className="working-dot" />}
                          </div>
                        )}
                        {ticket.note && <p className="note">{ticket.note}</p>}
                      </button>
                      <footer className="ticket-actions">
                        {ticket.agent === "Memo" ? (
                          <>
                            <button onClick={() => selectTicket(ticket)}>編集</button>
                            <button className="delete-button" onClick={() => deleteTodo(ticket.id)}>削除</button>
                          </>
                        ) : (
                          <>
                            <span className="session-model">
                              {ticket.agent === "Codex" ? "CODEX" : "CLAUDE"}{ticket.model ? ` · ${ticket.model}` : ""}{ticket.effort ? ` · ${ticket.effort}` : ""}
                            </span>
                            {ticket.status === "DONE" ? (
                              <span className="auto-sync">● DONE</span>
                            ) : (
                              <button className="done-button" onClick={() => markSessionDone(ticket.id)}>DONEへ</button>
                            )}
                          </>
                        )}
                      </footer>
                    </article>
                  ))}
                  {items.length === 0 && <div className="empty">ここにセッションが入ります</div>}
                </div>
              </section>
            );
          })}
        </div>
      </section>

      {selected && (
        <aside className="inspector" aria-label="選択中のセッション">
          <button className="close" onClick={() => setSelectedId("")} aria-label="詳細を閉じる">×</button>
          <span className="inspector-label">{selected.agent === "Memo" ? "EDIT TODO" : "SELECTED SESSION"}</span>
          <div className="inspector-agent">
            <span className={`agent-icon ${selected.agent === "Codex" ? "codex" : "claude"}`}>
              {selected.agent === "Codex" ? "C" : selected.agent === "Claude Code" ? "A" : "M"}
            </span>
            <div><strong>{selected.agent}</strong><small>{selected.session ?? "未割り当て"}</small></div>
          </div>
          {selected.agent === "Memo" ? (
            <>
              <label htmlFor="title">タイトル</label>
              <input id="title" value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
            </>
          ) : <h2>{selected.title}</h2>}
          <dl>
            <div><dt>STATUS</dt><dd>{columns.find((column) => column.id === selected.status)?.label}</dd></div>
            <div><dt>PROJECT</dt><dd>{selected.project}</dd></div>
          </dl>
          {selected.agent !== "Memo" && <div className="current-work"><span>NOW</span><p>{selected.note}</p></div>}
          <label htmlFor="comment">{selected.agent === "Memo" ? "メモ" : "コメントを更新"}</label>
          <textarea id="comment" value={draft} onChange={(event) => setDraft(event.target.value)} />
          <button className="save-button" onClick={saveTicket}>更新を保存</button>
        </aside>
      )}
    </main>
  );
}
