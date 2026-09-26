"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGES, type Resume, type SessionSummary } from "@/lib/types";

type SettingsInfo = { hasLlmKey: boolean; hasDeepgramKey: boolean; hasOpenaiKey: boolean; provider: string; language: string; sttProvider: string };

export default function Dashboard() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", language: "en", resume_id: "", job_description: "", extra_context: "" });
  const [pasteResume, setPasteResume] = useState(false);
  const [resumeText, setResumeText] = useState("");
  const [savingResume, setSavingResume] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const addResume = async (payload: FormData | { name: string; content: string }) => {
    setSavingResume(true);
    const r = payload instanceof FormData
      ? await fetch("/api/resumes", { method: "POST", body: payload })
      : await fetch("/api/resumes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json();
    setSavingResume(false);
    if (j.item) {
      setResumes((rs) => [j.item, ...rs]);
      setForm((f) => ({ ...f, resume_id: j.item.id }));
      setPasteResume(false);
      setResumeText("");
    } else alert(j.error || "Could not add résumé");
  };

  const [tick, setTick] = useState(0);
  const load = () => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, r, st] = await Promise.all([
        fetch("/api/sessions").then((r) => r.json()),
        fetch("/api/resumes").then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
      ]);
      if (!alive) return;
      setSessions(s.sessions);
      setResumes(r.resumes);
      setSettings(st);
      setForm((f) => ({ ...f, language: st.language || "en", resume_id: f.resume_id || r.resumes?.[0]?.id || "" }));
    })();
    return () => { alive = false; };
  }, [tick]);

  const stats = useMemo(() => {
    const list = sessions ?? [];
    const mins = list.reduce((a, s) => a + ((s.ended_at ?? s.created_at) - s.created_at), 0) / 60000;
    return { count: list.length, questions: list.reduce((a, s) => a + s.question_count, 0), mins: Math.round(mins) };
  }, [sessions]);

  const create = async () => {
    setCreating(true);
    const r = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, title: form.title || defaultTitle() }),
    });
    const j = await r.json();
    setCreating(false);
    if (j.session) router.push(`/session/${j.session.id}`);
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this session and its transcript?")) return;
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-6 rise">
        <div>
          <div className="chip chip-amber mb-3"><span className="dot" /> live copilot</div>
          <h1 className="text-4xl md:text-5xl leading-[1.02]">
            Say the right thing,<br />
            <span style={{ color: "var(--amber)" }}>while they&apos;re still asking.</span>
          </h1>
          <p className="text-muted mt-3 max-w-xl">
            Parak listens to your interview, transcribes both sides, and streams an answer grounded in your résumé
            before the interviewer finishes the sentence.
          </p>
        </div>
        <button className="btn btn-amber btn-lg" onClick={() => setOpen(true)}>
          + New session
        </button>
      </header>

      {settings && !settings.hasLlmKey && (
        <div className="panel mt-8 p-4 flex flex-wrap items-center gap-4 rise d1" style={{ borderColor: "rgba(244,178,58,0.4)" }}>
          <span className="chip chip-amber">setup</span>
          <span className="text-sm">
            No {settings.provider === "openai" ? "OpenAI" : "Anthropic"} API key yet — answers won&apos;t generate. Add one in{" "}
            <Link href="/settings" className="underline" style={{ color: "var(--amber)" }}>Settings</Link> or via{" "}
            <span className="mono">{settings.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}</span>.
          </span>
        </div>
      )}

      <section className="grid grid-cols-3 gap-3 mt-10 rise d1">
        {[
          { k: "Sessions", v: stats.count },
          { k: "Questions answered", v: stats.questions },
          { k: "Minutes on air", v: stats.mins },
        ].map((s) => (
          <div key={s.k} className="panel p-4">
            <div className="label">{s.k}</div>
            <div className="display text-3xl">{s.v}</div>
          </div>
        ))}
      </section>

      <section className="mt-10 rise d2">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg">Recent sessions</h2>
          <span className="mono text-xs text-dim">{sessions?.length ?? "…"} total</span>
        </div>
        <div className="panel divide-y divide-line">
          {sessions === null && <div className="p-6 text-muted">Loading…</div>}
          {sessions?.length === 0 && (
            <div className="p-10 text-center">
              <div className="display text-2xl mb-1">No sessions yet</div>
              <p className="text-muted">Upload a résumé in the Library, then start your first session.</p>
            </div>
          )}
          {sessions?.map((s) => (
            <div key={s.id} className="flex items-center gap-4 p-4 hover:bg-white/[0.02] transition-colors">
              <Link href={`/session/${s.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{s.title}</span>
                  {s.status === "active" ? (
                    <span className="chip chip-live"><span className="dot dot-pulse" /> live</span>
                  ) : (
                    <span className="chip">ended</span>
                  )}
                </div>
                <div className="mono text-xs text-muted mt-1">
                  {new Date(s.created_at).toLocaleString()} · {s.line_count} lines · {s.question_count} answers ·{" "}
                  {LANGUAGES.find((l) => l.code === s.language)?.label ?? s.language}
                </div>
              </Link>
              <Link href={`/session/${s.id}`} className="btn btn-sm">
                {s.status === "active" ? "Resume" : "Review"}
              </Link>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => remove(s.id)} aria-label="Delete">
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4" style={{ background: "rgba(5,6,9,0.7)", backdropFilter: "blur(6px)" }} onClick={() => setOpen(false)}>
          <div className="panel w-full max-w-2xl p-6 rise" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-2xl">New session</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Esc</button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="label">Title</label>
                <input className="input" placeholder={defaultTitle()} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div>
                <label className="label">Résumé</label>
                <div className="flex gap-2">
                  <select className="select" value={form.resume_id} onChange={(e) => setForm({ ...form, resume_id: e.target.value })}>
                    <option value="">— none —</option>
                    {resumes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <button type="button" className="btn btn-sm" onClick={() => fileRef.current?.click()} disabled={savingResume} title="Upload PDF / DOCX / TXT">{savingResume ? "…" : "PDF"}</button>
                  <button type="button" className="btn btn-sm" onClick={() => setPasteResume((p) => !p)} title="Paste résumé text">Paste</button>
                  <input ref={fileRef} type="file" hidden accept=".pdf,.txt,.md,.docx" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const fd = new FormData(); fd.append("file", f); addResume(fd); } e.target.value = ""; }} />
                </div>
                {resumes.length === 0 && !pasteResume && (
                  <div className="text-xs text-muted mt-1">No résumés yet — upload a PDF or paste text so answers use <b>your</b> experience.</div>
                )}
              </div>
              <div>
                <label className="label">Interview language</label>
                <select className="select" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
              </div>
              {pasteResume && (
                <div className="md:col-span-2">
                  <label className="label">Paste résumé text</label>
                  <textarea className="textarea" style={{ minHeight: 140 }} placeholder="Name, roles, projects, metrics, skills…" value={resumeText} onChange={(e) => setResumeText(e.target.value)} />
                  <div className="flex justify-end mt-2">
                    <button type="button" className="btn btn-sm btn-amber" disabled={!resumeText.trim() || savingResume} onClick={() => addResume({ name: `Résumé ${new Date().toLocaleDateString()}`, content: resumeText })}>
                      {savingResume ? "Saving…" : "Save & use this résumé"}
                    </button>
                  </div>
                </div>
              )}
              <div className="md:col-span-2">
                <label className="label">Job description (optional)</label>
                <textarea className="textarea" placeholder="Paste the JD so answers target the role…" value={form.job_description} onChange={(e) => setForm({ ...form, job_description: e.target.value })} />
              </div>
              <div className="md:col-span-2">
                <label className="label">Extra instructions (optional)</label>
                <textarea className="textarea" style={{ minHeight: 70 }} placeholder="e.g. Emphasize my fintech work. Keep answers under 60 seconds. Company is Stripe." value={form.extra_context} onChange={(e) => setForm({ ...form, extra_context: e.target.value })} />
              </div>
            </div>
            <div className="flex items-center justify-between mt-6">
              <span className="text-xs text-muted">
                STT: <span className="mono">{settings?.sttProvider === "webspeech" ? "browser" : settings?.sttProvider === "openai" ? (settings.hasOpenaiKey ? "openai realtime" : "openai (no key!)") : settings?.hasDeepgramKey ? "deepgram" : "deepgram (no key!)"}</span>
              </span>
              <button className="btn btn-amber" disabled={creating} onClick={create}>
                {creating ? "Starting…" : "Start session →"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function defaultTitle() {
  const d = new Date();
  return `Interview ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}
