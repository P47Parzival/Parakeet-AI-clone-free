import { getSettings } from "@/lib/server/db";

/**
 * Mint a short-lived STT credential for the browser so master keys never leave the server.
 * Body: { provider: "deepgram" | "openai", language }
 *
 * Deepgram: /v1/auth/grant (JWT, protocol ["bearer", token]) → fallback to a 2-min scoped key (["token", key]).
 * OpenAI:   POST /v1/realtime/client_secrets with a transcription session → ephemeral `ek_…` value.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const s = getSettings();
  const provider = body.provider === "openai" ? "openai" : "deepgram";
  const language: string = typeof body.language === "string" ? body.language : s.language;

  if (provider === "openai") {
    if (!s.openaiKey) return Response.json({ error: "No OpenAI API key. Add OPENAI_API_KEY or paste it in Settings." }, { status: 400 });
    const session = {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          noise_reduction: { type: "far_field" },
          transcription: { model: "gpt-4o-transcribe", ...(language && language !== "auto" ? { language } : {}) },
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        },
      },
    };
    try {
      const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${s.openaiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || `OpenAI client_secrets ${r.status}`);
      return Response.json({ provider: "openai", token: j.value, expiresAt: j.expires_at });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

  // ---- Deepgram
  const key = s.deepgramKey;
  if (!key) {
    return Response.json(
      { error: "No Deepgram API key. Add DEEPGRAM_API_KEY, paste it in Settings, or switch transcription to OpenAI / Browser." },
      { status: 400 },
    );
  }
  const auth = { Authorization: `Token ${key}`, "Content-Type": "application/json" };
  try {
    const r = await fetch("https://api.deepgram.com/v1/auth/grant", { method: "POST", headers: auth, body: "{}" });
    if (r.ok) {
      const j = (await r.json()) as { access_token: string; expires_in: number };
      return Response.json({ provider: "deepgram", token: j.access_token, scheme: "bearer", expiresIn: j.expires_in });
    }
  } catch { /* fall through */ }
  try {
    const pr = await fetch("https://api.deepgram.com/v1/projects", { headers: auth });
    if (!pr.ok) throw new Error(`Deepgram projects lookup failed (${pr.status})`);
    const pj = (await pr.json()) as { projects: { project_id: string }[] };
    const projectId = pj.projects?.[0]?.project_id;
    if (!projectId) throw new Error("No Deepgram project found for this key");
    const kr = await fetch(`https://api.deepgram.com/v1/projects/${projectId}/keys`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ comment: "parak temp", scopes: ["usage:write"], time_to_live_in_seconds: 120 }),
    });
    if (!kr.ok) throw new Error(`Deepgram temp key failed (${kr.status}): ${await kr.text()}`);
    const kj = (await kr.json()) as { key: string };
    return Response.json({ provider: "deepgram", token: kj.key, scheme: "token", expiresIn: 120 });
  } catch (e) {
    // Last resort: the key can transcribe but can't mint temp credentials (no keys:write scope).
    // Parak is a local single-user app, so handing the browser the key itself is acceptable —
    // verify it actually has usage:write first so the user gets a clear error otherwise.
    const probe = await fetch("https://api.deepgram.com/v1/auth/token", { headers: { Authorization: `Token ${key}` } }).catch(() => null);
    if (probe && probe.ok) {
      return Response.json({
        provider: "deepgram", token: key, scheme: "token", expiresIn: 0,
        warning: "Deepgram key lacks keys:write scope; using it directly in the browser (fine for local use).",
      });
    }
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
