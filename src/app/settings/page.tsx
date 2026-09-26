"use client";

import { useEffect, useState } from "react";
import { attachLevelMeter, listAudioInputs, looksLikeLoopback } from "@/lib/client/audio";
import { UsagePanel, useUsage } from "@/components/UsageMeter";
import { ENDPOINT_PRESETS, LANGUAGES, MODELS, type Settings } from "@/lib/types";

type Info = Settings & {
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasDeepgramKey: boolean;
  anthropicFromEnv: boolean;
  openaiFromEnv: boolean;
  deepgramFromEnv: boolean;
};

export default function SettingsPage() {
  const [s, setS] = useState<Info | null>(null);
  const [form, setForm] = useState<Partial<Settings>>({});
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<string>("");

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((j) => { setS(j); setForm(j); });
  }, []);

  const save = async () => {
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const j = await r.json();
    setS(j);
    setForm(j);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const { report: usage } = useUsage(undefined, 60_000);
  // Listen to the chosen device for a few seconds so you can confirm the meeting's audio
  // actually arrives — before an interview, not during one.
  const [probe, setProbe] = useState<{ level: number; peak: number; running: boolean } | null>(null);
  const testDevice = async (deviceId: string) => {
    if (!deviceId) return;
    setProbe({ level: 0, peak: 0, running: true });
    let stopMeter: (() => void) | null = null;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stopMeter = attachLevelMeter(stream, (v) =>
        setProbe((p) => (p ? { ...p, level: v, peak: Math.max(p.peak, v) } : p)),
      );
      await new Promise((r) => setTimeout(r, 8000));
    } catch (e) {
      setDeviceErr(e instanceof Error ? e.message : String(e));
    } finally {
      stopMeter?.();
      stream?.getTracks().forEach((t) => t.stop());
      setProbe((p) => (p ? { ...p, running: false } : p));
    }
  };

  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [deviceErr, setDeviceErr] = useState("");
  const loadDevices = async () => {
    setDeviceErr("");
    try {
      setDevices(await listAudioInputs());
    } catch (e) {
      setDeviceErr((e as Error).message);
    }
  };
  // Enumerating asks for mic permission, so only do it when the user picks loopback capture.
  const onCaptureMode = (mode: Settings["captureMode"]) => {
    setForm({ ...form, captureMode: mode });
    if (mode === "device" && devices === null) loadDevices();
  };

  const preset = ENDPOINT_PRESETS.find((p) => p.baseUrl === form.openaiBaseUrl);
  const [llmTest, setLlmTest] = useState("");
  const testLlm = async () => {
    setLlmTest("…");
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const r = await fetch("/api/llm/test", { method: "POST" });
    const j = await r.json();
    setLlmTest(r.ok ? `ok · ${j.model} · ${j.ms} ms · "${j.text}"` : `fail: ${j.error}`);
  };

  const testStt = async (provider: "deepgram" | "openai") => {
    setTesting("…");
    // Save first so the test uses what's typed in the box.
    await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const r = await fetch("/api/stt/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider }) });
    const j = await r.json();
    setTesting(r.ok ? `${provider} ok` : `${provider} fail: ${j.error}`);
  };

  if (!s) return <div className="p-10 text-muted">Loading…</div>;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <header className="rise">
        <div className="chip mb-3">configuration</div>
        <h1 className="text-4xl">Settings</h1>
        <p className="text-muted mt-2">Keys are stored in the local SQLite database (never sent anywhere except the vendor). Environment variables override these.</p>
      </header>

      <section className="panel p-6 mt-8 space-y-5 rise d1">
        <h2 className="text-xl">Provider &amp; keys</h2>
        <Field label="Answer provider" hint="Which LLM writes the answers, screenshot solutions and notes.">
          <div className="grid grid-cols-2 gap-2">
            {(["anthropic", "openai"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className="btn justify-center"
                style={form.provider === p ? { borderColor: "var(--amber)", background: "rgba(244,178,58,0.12)", color: "var(--amber-2)" } : undefined}
                onClick={() => setForm({ ...form, provider: p })}
              >
                {p === "anthropic" ? "Anthropic · Claude" : "OpenAI-compatible · Groq / Gemini / Ollama…"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Anthropic API key" hint={s.anthropicFromEnv ? "Set via ANTHROPIC_API_KEY (env wins)" : s.hasAnthropicKey ? "Saved" : "Needed when provider = Anthropic"}>
          <input className="input mono" placeholder="sk-ant-…" value={form.anthropicKey ?? ""} disabled={s.anthropicFromEnv} onChange={(e) => setForm({ ...form, anthropicKey: e.target.value })} />
        </Field>
        {form.provider === "openai" && (
          <>
            <Field label="Endpoint" hint={preset ? preset.note : "Any OpenAI-compatible /v1 base URL."}>
              <div className="grid md:grid-cols-[1fr_1.4fr] gap-2">
                <select
                  className="select"
                  value={preset?.id ?? "custom"}
                  onChange={(e) => {
                    const p = ENDPOINT_PRESETS.find((x) => x.id === e.target.value);
                    if (p) setForm({ ...form, openaiBaseUrl: p.baseUrl, openaiModel: p.model });
                  }}
                >
                  {ENDPOINT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
                <input className="input mono" value={form.openaiBaseUrl ?? ""} onChange={(e) => setForm({ ...form, openaiBaseUrl: e.target.value })} placeholder="https://…/v1" />
              </div>
              {preset && (
                <div className="text-xs mt-1">
                  Get a key: <a className="underline" style={{ color: "var(--amber)" }} href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl}</a>
                  {!preset.vision && <span className="text-muted"> · screenshot solving may need a vision model here</span>}
                </div>
              )}
            </Field>
            <Field label="Model">
              <input className="input mono" list="endpoint-models" value={form.openaiModel ?? ""} onChange={(e) => setForm({ ...form, openaiModel: e.target.value })} placeholder="model id" />
              <datalist id="endpoint-models">
                {(preset?.models ?? []).map((m) => <option key={m} value={m} />)}
              </datalist>
            </Field>
          </>
        )}
        <Field label={form.provider === "openai" && preset && preset.id !== "openai" ? `${preset.label.split(" (")[0]} API key` : "OpenAI API key"} hint={s.openaiFromEnv ? "Set via OPENAI_API_KEY (env wins)" : s.hasOpenaiKey ? "Saved" : form.provider === "openai" ? "Required for answers (Ollama: leave blank)" : "Only needed for OpenAI transcription"}>
          <div className="flex gap-2">
            <input className="input mono" placeholder="key…" value={form.openaiKey ?? ""} disabled={s.openaiFromEnv} onChange={(e) => setForm({ ...form, openaiKey: e.target.value })} />
            {form.provider === "openai" && <button className="btn" type="button" onClick={testLlm}>Test answers</button>}
            {(!preset || preset.id === "openai") && <button className="btn" type="button" onClick={() => testStt("openai")}>Test STT</button>}
          </div>
          {llmTest && <div className="mono text-xs mt-1" style={{ color: llmTest.startsWith("ok") ? "var(--mint)" : "var(--rose)" }}>{llmTest}</div>}
        </Field>
        <Field label="Deepgram API key" hint={s.deepgramFromEnv ? "Set via DEEPGRAM_API_KEY (env wins)" : s.hasDeepgramKey ? "Saved" : "Optional — alternative real-time transcription"}>
          <div className="flex gap-2">
            <input className="input mono" placeholder="dg_…" value={form.deepgramKey ?? ""} disabled={s.deepgramFromEnv} onChange={(e) => setForm({ ...form, deepgramKey: e.target.value })} />
            <button className="btn" type="button" onClick={() => testStt("deepgram")}>Test STT</button>
          </div>
        </Field>
        {testing && <div className="mono text-xs" style={{ color: testing.includes(" ok") ? "var(--mint)" : "var(--rose)" }}>{testing}</div>}
      </section>

      <section className="panel p-6 mt-6 space-y-5 rise d2">
        <h2 className="text-xl">Copilot</h2>
        {form.provider !== "openai" && (
          <Field label="Claude model">
            <select className="select" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.note}</option>)}
            </select>
          </Field>
        )}
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Default language">
            <select className="select" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Answer style">
            <select className="select" value={form.answerStyle} onChange={(e) => setForm({ ...form, answerStyle: e.target.value as Settings["answerStyle"] })}>
              <option value="concise">Concise — headline + bullets</option>
              <option value="detailed">Detailed — fuller STAR answers</option>
            </select>
          </Field>
          <Field label="Auto-answer" hint="When to generate an answer without you clicking.">
            <select className="select" value={form.autoAnswer} onChange={(e) => setForm({ ...form, autoAnswer: e.target.value as Settings["autoAnswer"] })}>
              <option value="questions">When the interviewer asks a question</option>
              <option value="always">After every interviewer utterance</option>
              <option value="off">Off — manual only</option>
            </select>
          </Field>
          <Field label="Audio source" hint="Loopback device = cleanest: the interviewer arrives on a virtual input, Parak never screen-shares, so your own share to the interviewer is never disturbed. Tab + mic starts a screen share and can fight with one. Mic only = put the call on speaker.">
            <select className="select" value={form.captureMode} onChange={(e) => onCaptureMode(e.target.value as Settings["captureMode"])}>
              <option value="mic">Microphone only (default)</option>
              <option value="device">Loopback device + microphone (no screen share)</option>
              <option value="tab">Meeting tab audio + microphone (screen share)</option>
            </select>
          </Field>
          {form.captureMode === "device" && (
            <Field label="Interviewer input device" hint="Route the meeting's output into a virtual input, then pick it here. macOS: BlackHole 2ch + a Multi-Output Device. Windows: VB-Cable or “Stereo Mix”.">
              <div className="flex gap-2">
                <select className="select" value={form.themDeviceId ?? ""} onChange={(e) => setForm({ ...form, themDeviceId: e.target.value })}>
                  <option value="">— pick a device —</option>
                  {(devices ?? []).map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {looksLikeLoopback(d.label) ? "★ " : ""}{d.label || `input ${d.deviceId.slice(0, 6)}`}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" type="button" onClick={loadDevices}>Rescan</button>
                <button className="btn btn-sm" type="button" disabled={!form.themDeviceId || probe?.running} onClick={() => testDevice(form.themDeviceId ?? "")}>
                  {probe?.running ? "Listening…" : "Test 8s"}
                </button>
              </div>
              {probe && (
                <div className="mt-2">
                  <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.round(probe.level * 100)}%`, height: "100%", background: "var(--mint)" }} />
                  </div>
                  <p className="mono text-[11px] mt-1" style={{ color: probe.peak > 0.08 ? "var(--mint)" : "var(--amber)" }}>
                    {probe.running
                      ? "Play the meeting audio now — the bar should move."
                      : probe.peak > 0.08
                        ? `Audio detected (peak ${Math.round(probe.peak * 100)}%). This device will hear the interviewer.`
                        : "Silent. The meeting's output is not routed into this device — set the call's speaker to your Multi-Output Device."}
                  </p>
                </div>
              )}
              {deviceErr && <p className="mono text-xs mt-1" style={{ color: "var(--rose)" }}>{deviceErr}</p>}
              {devices && !devices.some((d) => looksLikeLoopback(d.label)) && (
                <p className="text-xs text-muted mt-1">
                  <b className="text-ink">No loopback device found — this is why Google Meet cannot be heard.</b> A microphone
                  cannot pick up a call playing through headphones, and browser echo cancellation strips it even on speakers.
                  Fix on macOS: <code className="mono">brew install blackhole-2ch</code> → open <b className="text-ink">Audio MIDI Setup</b> →
                  <b className="text-ink"> + → Create Multi-Output Device</b> → tick your speakers/headphones <i>and</i> BlackHole 2ch →
                  set that Multi-Output Device as your Mac&apos;s output → pick <b className="text-ink">BlackHole 2ch</b> above.
                  You keep hearing the call normally; Parak gets a clean copy.
                </p>
              )}
            </Field>
          )}
          <Field label="Answer delay" hint="Silence required before an auto-answer fires. Higher = the copilot waits for you (or the interviewer) to finish instead of answering mid-sentence.">
            <select className="select" value={form.answerDelayMs ?? "1400"} onChange={(e) => setForm({ ...form, answerDelayMs: e.target.value })}>
              <option value="700">0.7s — snappy</option>
              <option value="1400">1.4s — balanced (default)</option>
              <option value="2500">2.5s — patient</option>
              <option value="4000">4s — only in long pauses</option>
            </select>
          </Field>
          <Field label="Answer speed" hint="Live answers only. Fast uses Claude Sonnet 5 — measured ~0.6s to the first word vs ~2.5s on Opus 5. Screenshots and post-interview notes always use the model above.">
            <select className="select" value={form.answerSpeed ?? "fast"} onChange={(e) => setForm({ ...form, answerSpeed: e.target.value as Settings["answerSpeed"] })}>
              <option value="fast">Fast — Sonnet 5, ~0.6s to first word (recommended)</option>
              <option value="best">Best — use the model above, slower to start</option>
            </select>
          </Field>
          <Field label="Answer-now hotkey" hint="Hold the key on its own for a third of a second — in Parak or the floating pop-out — and the copilot answers instantly with everything the interviewer just said, even mid-sentence. No waiting for the silence delay. (Browser windows can't see keys pressed while another app is focused — click the pop-out once so it has focus.)">
            <select className="select" value={form.answerHotkey ?? "ctrl"} onChange={(e) => setForm({ ...form, answerHotkey: e.target.value as Settings["answerHotkey"] })}>
              <option value="ctrl">Hold ⌃ Control (recommended)</option>
              <option value="alt">Hold ⌥ Option / Alt</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <Field label="Monthly budget (USD)" hint="What you plan to spend per month. The percentage meters count down against it. Deepgram shows its real account balance instead when the key has the billing:read scope. Set 0 to hide the percentages.">
            <input className="input mono" inputMode="decimal" value={form.budgetUsd ?? "20"} onChange={(e) => setForm({ ...form, budgetUsd: e.target.value })} placeholder="20" />
          </Field>
          <Field label="Pause while you speak" hint="Holds auto-answer whenever a microphone is picking up speech, so reading an answer out loud never triggers another one. ⌘/Ctrl+Shift+M holds it manually.">
            <select className="select" value={form.pauseWhileSpeaking ?? "on"} onChange={(e) => setForm({ ...form, pauseWhileSpeaking: e.target.value as Settings["pauseWhileSpeaking"] })}>
              <option value="on">On (recommended)</option>
              <option value="off">Off — answer as soon as a question lands</option>
            </select>
          </Field>
          <Field label="Transcription" hint="Deepgram / OpenAI hear the meeting tab + mic. Browser mode is mic-only and Chrome-only.">
            <select className="select" value={form.sttProvider} onChange={(e) => setForm({ ...form, sttProvider: e.target.value as Settings["sttProvider"] })}>
              <option value="openai">OpenAI Realtime (tab audio + mic)</option>
              <option value="deepgram">Deepgram Nova-3 (tab audio + mic)</option>
              <option value="webspeech">Browser Web Speech (no key, mic only)</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="panel p-6 mt-6 rise d2">
        <h2 className="text-xl mb-4">Usage &amp; credit</h2>
        <UsagePanel report={usage} />
        <p className="text-xs text-muted mt-4">
          Anthropic and OpenAI publish no “credits remaining” endpoint for a normal API key, so these bars meter what
          Parak actually spent — counted from the token usage each response returns — against your budget. Deepgram is the
          exception: with an Owner key it reports the real account balance.
        </p>
      </section>

      <div className="flex items-center justify-end gap-3 mt-6">
        {saved && <span className="mono text-xs" style={{ color: "var(--mint)" }}>saved</span>}
        <button className="btn btn-amber" onClick={save}>Save settings</button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}
