import { errorJson, streamText } from "@/lib/server/llm";
import { getSettings } from "@/lib/server/db";

/** Quick round-trip through the active LLM provider — used by the Settings "Test answers" button. */
export async function POST() {
  const t0 = Date.now();
  try {
    const s = getSettings();
    const ts = streamText({ system: "Reply with exactly the two words: copilot ready", text: "ping", maxTokens: 300, effort: "low" });
    let text = "";
    for await (const d of ts.deltas) text += d;
    await ts.done();
    return Response.json({ ok: true, provider: s.provider, model: s.provider === "openai" ? s.openaiModel : s.model, text: text.trim().slice(0, 80), ms: Date.now() - t0 });
  } catch (e) {
    return errorJson(e);
  }
}
