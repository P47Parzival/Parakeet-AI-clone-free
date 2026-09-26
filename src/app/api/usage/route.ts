import { getSettings, recordUsage, usageTotals } from "@/lib/server/db";
import { STT_RATE_PER_MIN, sttCost } from "@/lib/server/pricing";
import type { ProviderMeter, UsageReport } from "@/lib/types";

/**
 * What's left, per provider.
 *
 * Only Deepgram publishes a live balance (and only to keys with the billing:read scope).
 * For everything else the vendors expose no "credits remaining" endpoint on a normal API
 * key, so Parak meters its own spend from the token counts the APIs return and reports it
 * against the budget you set in Settings. Every meter says which of the two it is.
 */

type Balance = { usd: number } | { error: string };

// The meter polls every 30s from every open tab; the balance moves far slower than that,
// and a stalled vendor call must not hold up the whole report during an interview.
const balanceCache = new Map<string, { at: number; value: Balance }>();
const BALANCE_TTL_MS = 60_000;

async function deepgramBalance(key: string): Promise<Balance> {
  const hit = balanceCache.get(key);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.value;
  const value = await fetchDeepgramBalance(key);
  balanceCache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchDeepgramBalance(key: string): Promise<Balance> {
  const signal = AbortSignal.timeout(4000);
  try {
    const pr = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${key}` },
      signal,
    });
    if (!pr.ok) return { error: `projects ${pr.status}` };
    const pj = (await pr.json()) as { projects: { project_id: string }[] };
    const id = pj.projects?.[0]?.project_id;
    if (!id) return { error: "no project" };
    const br = await fetch(`https://api.deepgram.com/v1/projects/${id}/balances`, {
      headers: { Authorization: `Token ${key}` },
      signal,
    });
    if (br.status === 403) return { error: "key lacks the billing:read scope — create an Owner key to see the real balance" };
    if (!br.ok) return { error: `balances ${br.status}` };
    const bj = (await br.json()) as { balances?: { amount: number; units: string }[] };
    const usd = (bj.balances ?? [])
      .filter((b) => b.units === "usd")
      .reduce((n, b) => n + b.amount, 0);
    return { usd };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Short name for whatever OpenAI-compatible endpoint is configured; never throws on a bad URL. */
function endpointLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^api\./, "");
  } catch {
    return "OpenAI-compatible";
  }
}

function monthStart(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export async function GET(req: Request) {
  const s = getSettings();
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId") ?? undefined;

  const since = monthStart();
  const month = usageTotals(since);
  const session = sessionId ? usageTotals(0, sessionId) : [];
  const spent = (rows: typeof month, provider: string) =>
    rows.filter((r) => r.provider === provider).reduce((n, r) => n + r.cost_usd, 0);

  const budget = Math.max(0, Number(s.budgetUsd) || 0);
  const llmProvider = s.provider;
  const meters: ProviderMeter[] = [];

  // ---- the LLM doing the answering
  const llmSpent = spent(month, llmProvider);
  const llmModel = llmProvider === "openai" ? s.openaiModel : s.model;
  const priced = month.some((r) => r.provider === llmProvider && r.cost_usd > 0) || llmSpent > 0;
  meters.push({
    provider: llmProvider,
    label: llmProvider === "anthropic" ? "Anthropic" : endpointLabel(s.openaiBaseUrl),
    role: "answers",
    model: llmModel,
    source: "budget",
    spentUsd: llmSpent,
    budgetUsd: budget,
    percentLeft: budget ? Math.max(0, Math.min(100, ((budget - llmSpent) / budget) * 100)) : null,
    tokens: month
      .filter((r) => r.provider === llmProvider)
      .reduce((n, r) => n + r.input + r.output + r.cache_read + r.cache_write, 0),
    sessionUsd: spent(session, llmProvider),
    note: priced ? undefined : "This endpoint has no published price — spend shows as $0.",
  });

  // ---- transcription
  if (s.sttProvider === "deepgram" && s.deepgramKey) {
    const bal = await deepgramBalance(s.deepgramKey);
    const dgSpent = spent(month, "deepgram");
    meters.push({
      provider: "deepgram",
      label: "Deepgram",
      role: "transcription",
      model: "nova-3",
      source: "usd" in bal ? "account" : "budget",
      spentUsd: dgSpent,
      balanceUsd: "usd" in bal ? bal.usd : undefined,
      budgetUsd: budget,
      // A real balance is measured against the $200 of credit a new account starts with.
      percentLeft:
        "usd" in bal
          ? Math.max(0, Math.min(100, (bal.usd / 200) * 100))
          : budget
            ? Math.max(0, Math.min(100, ((budget - dgSpent) / budget) * 100))
            : null,
      minutes: month.filter((r) => r.provider === "deepgram").reduce((n, r) => n + r.seconds, 0) / 60,
      sessionUsd: spent(session, "deepgram"),
      note: "error" in bal ? bal.error : undefined,
    });
  } else if (s.sttProvider === "openai") {
    const oSpent = month.filter((r) => r.provider === "openai" && r.service === "stt").reduce((n, r) => n + r.cost_usd, 0);
    meters.push({
      provider: "openai-stt",
      label: "OpenAI transcription",
      role: "transcription",
      model: "gpt-4o-transcribe",
      source: "budget",
      spentUsd: oSpent,
      budgetUsd: budget,
      percentLeft: budget ? Math.max(0, Math.min(100, ((budget - oSpent) / budget) * 100)) : null,
      minutes: month.filter((r) => r.provider === "openai" && r.service === "stt").reduce((n, r) => n + r.seconds, 0) / 60,
      sessionUsd: 0,
    });
  } else {
    meters.push({
      provider: "webspeech",
      label: "Browser speech",
      role: "transcription",
      model: "web speech api",
      source: "free",
      spentUsd: 0,
      percentLeft: 100,
      sessionUsd: 0,
      note: "Free — nothing to meter.",
    });
  }

  const report: UsageReport = {
    monthStart: since,
    budgetUsd: budget,
    totalSpentUsd: month.reduce((n, r) => n + r.cost_usd, 0),
    sessionSpentUsd: session.reduce((n, r) => n + r.cost_usd, 0),
    meters,
  };
  return Response.json(report);
}

/** Books transcription time from the browser — the only place that knows how long the mic ran. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const seconds = Math.max(0, Math.min(4 * 3600, Number(body.seconds) || 0));
  const provider = String(body.provider || "");
  if (!seconds || !(provider in STT_RATE_PER_MIN)) return Response.json({ ok: false }, { status: 400 });
  recordUsage({
    provider,
    service: "stt",
    session_id: body.sessionId ? String(body.sessionId) : null,
    seconds,
    cost_usd: sttCost(provider, seconds),
  });
  return Response.json({ ok: true });
}
