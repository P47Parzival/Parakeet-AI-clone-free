"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Answer, TranscriptLine } from "@/lib/types";

/**
 * Phone/tablet view of the copilot. Polls instead of streaming — an answer lands here a
 * moment after it finishes rather than word by word, which is the right trade for a second
 * screen you glance at. Read-only on purpose: nothing here can disturb the live session.
 */
export function LiveView({ id }: { id: string }) {
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [title, setTitle] = useState("");
  const [err, setErr] = useState("");
  const [scale, setScale] = useState(1);
  const [awake, setAwake] = useState(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
      const j = await r.json();
      if (j.error) { setErr(j.error); return; }
      setErr("");
      setTitle(j.session.title);
      setAnswers(j.answers ?? []);
      setLines(j.transcript ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) poll(); };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearTimeout(first); clearInterval(t); };
  }, [poll]);

  // A phone that sleeps mid-question is useless; ask it to stay awake while this is open.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } };
    nav.wakeLock?.request("screen").then((l) => { lock = l; setAwake(true); }).catch(() => setAwake(false));
    return () => { lock?.release().catch(() => {}); };
  }, []);

  const latest = answers[answers.length - 1];
  const older = [...answers].slice(0, -1).reverse().slice(0, 5);
  const lastThem = [...lines].reverse().find((l) => l.speaker === "them")?.text ?? "";

  return (
    <div className="min-h-screen flex flex-col" style={{ fontSize: `${scale}rem` }}>
      <header className="px-4 py-2 border-b border-line flex items-center gap-2 sticky top-0 z-10" style={{ background: "var(--panel)" }}>
        <span className="chip chip-live"><span className="dot dot-pulse" /> phone view</span>
        <span className="text-sm truncate">{title}</span>
        <div className="flex-1" />
        <button className="btn btn-ghost btn-sm" onClick={() => setScale((v) => Math.max(0.8, +(v - 0.1).toFixed(1)))}>A−</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setScale((v) => Math.min(1.8, +(v + 0.1).toFixed(1)))}>A+</button>
      </header>

      {err && <div className="px-4 py-2 text-sm" style={{ color: "var(--rose)" }}>{err}</div>}

      <div className="px-4 py-2 text-xs border-b border-line" style={{ color: "var(--amber)", background: "rgba(244,178,58,0.06)" }}>
        <span className="mono text-[10px] tracking-widest uppercase text-muted mr-2">them</span>
        {lastThem || "…listening"}
      </div>

      <main className="flex-1 px-4 py-3 space-y-3">
        {!latest && <p className="text-muted text-sm mt-6">Answers appear here as the interviewer asks questions. Keep this open on your phone — it is not on the screen you share.</p>}
        {latest && (
          <section className="panel p-3" style={{ borderColor: "rgba(244,178,58,0.35)" }}>
            <div className="text-xs text-muted line-clamp-2 mb-1">{latest.question}</div>
            <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{latest.answer}</ReactMarkdown></div>
          </section>
        )}
        {older.map((a) => (
          <details key={a.id} className="panel p-2 text-sm">
            <summary className="cursor-pointer text-muted line-clamp-1">{a.question}</summary>
            <div className="md mt-2"><ReactMarkdown remarkPlugins={[remarkGfm]}>{a.answer}</ReactMarkdown></div>
          </details>
        ))}
      </main>

      <footer className="px-4 py-2 mono text-[10px] text-dim border-t border-line">
        read-only · updates every 1.5s · {awake ? "screen kept awake" : "screen may sleep"}
      </footer>
    </div>
  );
}
