import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  Answer,
  Doc,
  Resume,
  Session,
  SessionSummary,
  Settings,
  Speaker,
  TranscriptLine,
} from "../types";

const DB_PATH =
  process.env.PARAK_DB_PATH || path.join(process.cwd(), "data", "parak.db");

declare global {
  var __parakDb: Database.Database | undefined;
}

function open(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resumes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, language TEXT NOT NULL,
      resume_id TEXT, job_description TEXT NOT NULL DEFAULT '', extra_context TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, ended_at INTEGER, notes_json TEXT);
    CREATE TABLE IF NOT EXISTS transcript (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS transcript_session ON transcript(session_id, ts);
    CREATE TABLE IF NOT EXISTS answers (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
      kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS answers_session ON answers(session_id, created_at);
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
      provider TEXT NOT NULL,           -- anthropic | openai | deepgram | webspeech
      service TEXT NOT NULL,            -- llm | stt
      model TEXT NOT NULL DEFAULT '', session_id TEXT,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      seconds REAL NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
    CREATE INDEX IF NOT EXISTS usage_session ON usage(session_id);
  `);
  return db;
}

export const db: Database.Database = globalThis.__parakDb ?? open();
if (process.env.NODE_ENV !== "production") globalThis.__parakDb = db;

// ---------- settings ----------
const DEFAULT_SETTINGS: Settings = {
  provider: "anthropic",
  anthropicKey: "",
  openaiKey: "",
  deepgramKey: "",
  model: "claude-opus-5",
  openaiBaseUrl: "https://api.groq.com/openai/v1",
  openaiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
  language: "en",
  autoAnswer: "always",
  answerStyle: "concise",
  sttProvider: "openai",
  captureMode: "mic",
  themDeviceId: "",
  answerDelayMs: "1400",
  pauseWhileSpeaking: "on",
  budgetUsd: "20",
  answerSpeed: "fast",
  answerHotkey: "ctrl",
};

export function getSettings(): Settings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in s) (s as unknown as Record<string, string>)[r.key] = r.value;
  }
  // Env vars win over DB-stored keys.
  if (process.env.ANTHROPIC_API_KEY) s.anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.DEEPGRAM_API_KEY) s.deepgramKey = process.env.DEEPGRAM_API_KEY;
  if (process.env.OPENAI_API_KEY) s.openaiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE_URL) s.openaiBaseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_MODEL) s.openaiModel = process.env.OPENAI_MODEL;
  // If the chosen provider has no key but the other one does, use the one that works.
  const isLocalLlm = /localhost|127\.0\.0\.1/.test(s.openaiBaseUrl);
  if (s.provider === "anthropic" && !s.anthropicKey && (s.openaiKey || isLocalLlm)) s.provider = "openai";
  if (s.provider === "openai" && !s.openaiKey && !isLocalLlm && s.anthropicKey) s.provider = "anthropic";
  // Same for transcription: fall back to whatever cloud STT has a key, else the browser.
  if (s.sttProvider === "openai" && !s.openaiKey) s.sttProvider = s.deepgramKey ? "deepgram" : "webspeech";
  if (s.sttProvider === "deepgram" && !s.deepgramKey) s.sttProvider = s.openaiKey ? "openai" : "webspeech";
  // Loopback capture needs a device to listen on; without one it is just mic mode.
  if (s.captureMode === "device" && !s.themDeviceId) s.captureMode = "mic";
  return s;
}

export function setSettings(patch: Partial<Settings>) {
  const stmt = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = db.transaction((p: Partial<Settings>) => {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      stmt.run(k, String(v));
    }
  });
  tx(patch);
}

// ---------- resumes / documents ----------
export function listResumes(): Resume[] {
  return db
    .prepare("SELECT * FROM resumes ORDER BY created_at DESC")
    .all() as Resume[];
}
export function getResume(id: string): Resume | undefined {
  return db.prepare("SELECT * FROM resumes WHERE id = ?").get(id) as
    | Resume
    | undefined;
}
export function createResume(name: string, content: string): Resume {
  const r: Resume = { id: nanoid(10), name, content, created_at: Date.now() };
  db.prepare(
    "INSERT INTO resumes(id, name, content, created_at) VALUES (@id, @name, @content, @created_at)",
  ).run(r);
  return r;
}
export function deleteResume(id: string) {
  db.prepare("DELETE FROM resumes WHERE id = ?").run(id);
}

export function listDocs(): Doc[] {
  return db
    .prepare("SELECT * FROM documents ORDER BY created_at DESC")
    .all() as Doc[];
}
export function createDoc(name: string, content: string): Doc {
  const d: Doc = { id: nanoid(10), name, content, created_at: Date.now() };
  db.prepare(
    "INSERT INTO documents(id, name, content, created_at) VALUES (@id, @name, @content, @created_at)",
  ).run(d);
  return d;
}
export function deleteDoc(id: string) {
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

// ---------- sessions ----------
export function listSessions(): SessionSummary[] {
  return db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM answers a WHERE a.session_id = s.id) AS question_count,
        (SELECT COUNT(*) FROM transcript t WHERE t.session_id = s.id) AS line_count
       FROM sessions s ORDER BY created_at DESC`,
    )
    .all() as SessionSummary[];
}

export function getSession(id: string): Session | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | Session
    | undefined;
}

export function createSession(input: {
  title: string;
  language: string;
  resume_id: string | null;
  job_description: string;
  extra_context: string;
}): Session {
  const s: Session = {
    id: nanoid(10),
    title: input.title,
    language: input.language,
    resume_id: input.resume_id,
    job_description: input.job_description,
    extra_context: input.extra_context,
    status: "active",
    created_at: Date.now(),
    ended_at: null,
    notes_json: null,
  };
  db.prepare(
    `INSERT INTO sessions(id, title, language, resume_id, job_description, extra_context, status, created_at, ended_at, notes_json)
     VALUES (@id, @title, @language, @resume_id, @job_description, @extra_context, @status, @created_at, @ended_at, @notes_json)`,
  ).run(s);
  return s;
}

export function updateSession(
  id: string,
  patch: Partial<Pick<Session, "title" | "status" | "ended_at" | "notes_json" | "extra_context" | "job_description">>,
) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE sessions SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function deleteSession(id: string) {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM transcript WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM answers WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  tx();
}

// ---------- transcript / answers ----------
export function addTranscriptLine(
  session_id: string,
  speaker: Speaker,
  text: string,
  ts: number,
): TranscriptLine {
  const l: TranscriptLine = { id: nanoid(12), session_id, speaker, text, ts };
  db.prepare(
    "INSERT INTO transcript(id, session_id, speaker, text, ts) VALUES (@id, @session_id, @speaker, @text, @ts)",
  ).run(l);
  return l;
}

export function relabelTranscriptLines(session_id: string, ids: string[], speaker: Speaker) {
  if (!ids.length) return;
  const stmt = db.prepare("UPDATE transcript SET speaker = ? WHERE session_id = ? AND id = ?");
  const run = db.transaction((list: string[]) => { for (const id of list) stmt.run(speaker, session_id, id); });
  run(ids);
}

export function listTranscript(session_id: string): TranscriptLine[] {
  return db
    .prepare("SELECT * FROM transcript WHERE session_id = ? ORDER BY ts ASC")
    .all(session_id) as TranscriptLine[];
}

export function addAnswer(
  session_id: string,
  question: string,
  answer: string,
  kind: Answer["kind"],
): Answer {
  const a: Answer = {
    id: nanoid(12),
    session_id,
    question,
    answer,
    kind,
    created_at: Date.now(),
  };
  db.prepare(
    "INSERT INTO answers(id, session_id, question, answer, kind, created_at) VALUES (@id, @session_id, @question, @answer, @kind, @created_at)",
  ).run(a);
  return a;
}

export function listAnswers(session_id: string): Answer[] {
  return db
    .prepare("SELECT * FROM answers WHERE session_id = ? ORDER BY created_at ASC")
    .all(session_id) as Answer[];
}

// ---------- usage metering ----------
export interface UsageRow {
  provider: string;
  service: "llm" | "stt";
  model?: string;
  session_id?: string | null;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  seconds?: number;
  cost_usd: number;
}

export function recordUsage(u: UsageRow) {
  db.prepare(
    `INSERT INTO usage(id, ts, provider, service, model, session_id, input, output, cache_read, cache_write, seconds, cost_usd)
     VALUES (@id, @ts, @provider, @service, @model, @session_id, @input, @output, @cache_read, @cache_write, @seconds, @cost_usd)`,
  ).run({
    id: nanoid(12),
    ts: Date.now(),
    provider: u.provider,
    service: u.service,
    model: u.model ?? "",
    session_id: u.session_id ?? null,
    input: u.input ?? 0,
    output: u.output ?? 0,
    cache_read: u.cache_read ?? 0,
    cache_write: u.cache_write ?? 0,
    seconds: u.seconds ?? 0,
    cost_usd: u.cost_usd,
  });
}

export interface UsageTotals {
  provider: string;
  service: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  seconds: number;
  cost_usd: number;
  calls: number;
}

/** Totals grouped by provider + service. `since` is a millisecond timestamp. */
export function usageTotals(since = 0, sessionId?: string): UsageTotals[] {
  const where = sessionId ? "ts >= ? AND session_id = ?" : "ts >= ?";
  const args = sessionId ? [since, sessionId] : [since];
  return db
    .prepare(
      `SELECT provider, service,
              COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
              COALESCE(SUM(cache_read),0) AS cache_read, COALESCE(SUM(cache_write),0) AS cache_write,
              COALESCE(SUM(seconds),0) AS seconds, COALESCE(SUM(cost_usd),0) AS cost_usd,
              COUNT(*) AS calls
         FROM usage WHERE ${where}
        GROUP BY provider, service`,
    )
    .all(...args) as UsageTotals[];
}
