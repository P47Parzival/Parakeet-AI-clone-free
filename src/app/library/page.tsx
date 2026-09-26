"use client";

import { useEffect, useRef, useState } from "react";
import type { Doc, Resume } from "@/lib/types";

type Kind = "resumes" | "documents";

export default function LibraryPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <header className="rise">
        <div className="chip mb-3">knowledge base</div>
        <h1 className="text-4xl">Library</h1>
        <p className="text-muted mt-2 max-w-xl">
          Everything here is injected into the copilot&apos;s context. Résumés are picked per session; documents (portfolio notes,
          project write-ups, company research) are always available.
        </p>
      </header>
      <div className="grid lg:grid-cols-2 gap-6 mt-8">
        <Collection kind="resumes" title="Résumés" hint="PDF, DOCX, TXT or MD. Pick one per session." />
        <Collection kind="documents" title="Documents" hint="Supporting material — always in context." />
      </div>
    </div>
  );
}

function Collection({ kind, title, hint }: { kind: Kind; title: string; hint: string }) {
  const [items, setItems] = useState<(Resume | Doc)[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [paste, setPaste] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [tick, setTick] = useState(0);
  const load = () => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    fetch(`/api/${kind}`).then((r) => r.json()).then((j) => { if (alive) setItems(j[kind]); });
    return () => { alive = false; };
  }, [kind, tick]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setErr("");
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/api/${kind}`, { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) setErr(j.error || "Upload failed");
    }
    setBusy(false);
    load();
  };

  const savePaste = async () => {
    if (!pasteText.trim()) return;
    setBusy(true);
    const r = await fetch(`/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: pasteName || "Pasted text", content: pasteText }),
    });
    setBusy(false);
    if (r.ok) {
      setPaste(false);
      setPasteName("");
      setPasteText("");
      load();
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/${kind}/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <section className="panel p-5 rise d1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl">{title}</h2>
          <p className="text-xs text-muted">{hint}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-sm" onClick={() => setPaste((p) => !p)}>Paste text</button>
          <button className="btn btn-sm btn-amber" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Reading…" : "Upload"}
          </button>
          <input ref={fileRef} type="file" hidden multiple accept=".pdf,.txt,.md,.docx,text/plain,application/pdf" onChange={(e) => upload(e.target.files)} />
        </div>
      </div>

      <div
        className="mt-4 rounded-xl border border-dashed border-line-2 p-4 text-center text-sm text-muted transition-colors"
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "var(--amber)"; }}
        onDragLeave={(e) => { e.currentTarget.style.borderColor = ""; }}
        onDrop={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = ""; upload(e.dataTransfer.files); }}
      >
        Drop files here
      </div>

      {paste && (
        <div className="mt-4 space-y-2">
          <input className="input" placeholder="Name" value={pasteName} onChange={(e) => setPasteName(e.target.value)} />
          <textarea className="textarea" style={{ minHeight: 160 }} placeholder="Paste résumé / notes…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className="btn btn-sm btn-ghost" onClick={() => setPaste(false)}>Cancel</button>
            <button className="btn btn-sm btn-amber" onClick={savePaste} disabled={busy}>Save</button>
          </div>
        </div>
      )}
      {err && <div className="mt-3 text-sm" style={{ color: "var(--rose)" }}>{err}</div>}

      <ul className="mt-4 divide-y divide-line">
        {items === null && <li className="py-3 text-muted text-sm">Loading…</li>}
        {items?.length === 0 && <li className="py-3 text-muted text-sm">Nothing here yet.</li>}
        {items?.map((it) => (
          <li key={it.id} className="py-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">{it.name}</div>
              <div className="mono text-xs text-muted">{it.content.length.toLocaleString()} chars · {new Date(it.created_at).toLocaleDateString()}</div>
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => setPreview(preview === it.id ? null : it.id)}>
              {preview === it.id ? "Hide" : "Preview"}
            </button>
            <button className="btn btn-sm btn-ghost btn-danger" onClick={() => remove(it.id)}>✕</button>
          </li>
        ))}
      </ul>
      {preview && (
        <pre className="mono text-xs mt-3 p-3 rounded-lg max-h-72 overflow-auto scroll-thin whitespace-pre-wrap" style={{ background: "#070910", border: "1px solid var(--line)" }}>
          {items?.find((i) => i.id === preview)?.content.slice(0, 6000)}
        </pre>
      )}
    </section>
  );
}
