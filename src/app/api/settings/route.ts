import { getSettings, setSettings } from "@/lib/server/db";
import type { Settings } from "@/lib/types";

const mask = (k: string) => (k ? `${k.slice(0, 7)}…${k.slice(-4)}` : "");

export async function GET() {
  const s = getSettings();
  return Response.json({
    ...s,
    anthropicKey: mask(s.anthropicKey),
    openaiKey: mask(s.openaiKey),
    deepgramKey: mask(s.deepgramKey),
    hasAnthropicKey: !!s.anthropicKey,
    hasOpenaiKey: !!s.openaiKey,
    hasDeepgramKey: !!s.deepgramKey,
    /** true when the active LLM provider has a key */
    hasLlmKey: s.provider === "openai" ? !!s.openaiKey || /localhost|127\.0\.0\.1/.test(s.openaiBaseUrl) : !!s.anthropicKey,
    anthropicFromEnv: !!process.env.ANTHROPIC_API_KEY,
    openaiFromEnv: !!process.env.OPENAI_API_KEY,
    deepgramFromEnv: !!process.env.DEEPGRAM_API_KEY,
  });
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Partial<Settings>;
  const patch: Partial<Settings> = {};
  const allowed: (keyof Settings)[] = [
    "provider", "anthropicKey", "openaiKey", "deepgramKey", "model", "openaiBaseUrl", "openaiModel", "language", "autoAnswer", "answerStyle", "sttProvider", "captureMode",
    "themDeviceId", "answerDelayMs", "pauseWhileSpeaking", "budgetUsd", "answerSpeed", "answerHotkey",
  ];
  for (const k of allowed) {
    const v = body[k];
    if (typeof v !== "string") continue;
    // Ignore masked values echoed back from the UI.
    if ((k === "anthropicKey" || k === "deepgramKey" || k === "openaiKey") && v.includes("…")) continue;
    (patch as Record<string, string>)[k] = v;
  }
  setSettings(patch);
  return GET();
}
