"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderMeter, UsageReport } from "@/lib/types";

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `${(n * 100).toFixed(1)}¢`);

function barColor(pct: number | null) {
  if (pct === null) return "var(--muted)";
  if (pct <= 10) return "var(--rose)";
  if (pct <= 30) return "var(--amber)";
  return "var(--mint)";
}

/** How the number was arrived at — the difference matters, so it's always on screen. */
function sourceLabel(m: ProviderMeter) {
  if (m.source === "account") return "real balance";
  if (m.source === "free") return "free";
  return "vs. budget";
}

export function useUsage(sessionId?: string, intervalMs = 30_000) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const refresh = useCallback(async () => {
    try {
      const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const r = await fetch(`/api/usage${q}`);
      if (r.ok) setReport(await r.json());
    } catch {
      /* meter is decoration; never surface a failure here */
    }
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearTimeout(first); clearInterval(t); };
  }, [refresh, intervalMs]);

  return { report, refresh };
}

/** Header strip: one chip per provider showing the percentage left. */
export function UsageChips({ report, onClick }: { report: UsageReport | null; onClick?: () => void }) {
  if (!report) return null;
  return (
    <div className="flex items-center gap-1.5">
      {report.meters.map((m) => (
        <button
          key={m.provider}
          type="button"
          onClick={onClick}
          className="chip"
          title={`${m.label} · ${m.role} · ${sourceLabel(m)}\nspent ${usd(m.spentUsd)} this month${
            m.balanceUsd !== undefined ? `\nbalance ${usd(m.balanceUsd)}` : ""
          }${m.note ? `\n${m.note}` : ""}`}
        >
          <span className="dot" style={{ background: barColor(m.percentLeft) }} />
          <span className="mono text-[10px] uppercase tracking-wider">{m.label.slice(0, 9)}</span>
          <span className="mono text-[11px] tabular-nums" style={{ color: barColor(m.percentLeft) }}>
            {m.percentLeft === null ? "—" : `${Math.round(m.percentLeft)}%`}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Full panel: a bar per provider, plus what it cost this session. */
export function UsagePanel({ report }: { report: UsageReport | null }) {
  if (!report) return <div className="text-muted text-sm">Loading usage…</div>;
  return (
    <div className="space-y-4">
      {report.meters.map((m) => (
        <div key={m.provider}>
          <div className="flex items-baseline gap-2 mb-1">
            <span className="text-sm">{m.label}</span>
            <span className="mono text-[10px] uppercase tracking-wider text-dim">{m.role}</span>
            <div className="flex-1" />
            <span className="mono text-sm tabular-nums" style={{ color: barColor(m.percentLeft) }}>
              {m.percentLeft === null ? "no budget set" : `${Math.round(m.percentLeft)}% left`}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
            <div
              style={{
                width: `${m.percentLeft ?? 0}%`,
                height: "100%",
                background: barColor(m.percentLeft),
                transition: "width .4s ease",
              }}
            />
          </div>
          <div className="mono text-[11px] text-muted mt-1 flex flex-wrap gap-x-3">
            <span>{sourceLabel(m)}</span>
            <span>{m.model}</span>
            <span>spent {usd(m.spentUsd)}</span>
            {m.balanceUsd !== undefined && <span>balance {usd(m.balanceUsd)}</span>}
            {m.tokens !== undefined && m.tokens > 0 && <span>{m.tokens.toLocaleString()} tokens</span>}
            {m.minutes !== undefined && m.minutes > 0 && <span>{m.minutes.toFixed(1)} min audio</span>}
            {m.sessionUsd > 0 && <span>this session {usd(m.sessionUsd)}</span>}
          </div>
          {m.note && <div className="text-[11px] mt-1" style={{ color: "var(--amber)" }}>{m.note}</div>}
        </div>
      ))}
      <div className="mono text-[11px] text-dim pt-1 border-t border-line">
        {usd(report.totalSpentUsd)} spent since {new Date(report.monthStart).toLocaleDateString()} · budget{" "}
        {report.budgetUsd ? usd(report.budgetUsd) : "not set"}
      </div>
    </div>
  );
}
