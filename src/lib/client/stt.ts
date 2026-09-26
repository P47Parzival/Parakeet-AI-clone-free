"use client";

export interface TranscriptEvent {
  text: string;
  /** Interim (still changing) vs final. */
  isFinal: boolean;
  /** Deepgram: end of a spoken utterance (good moment to answer). */
  speechFinal: boolean;
  /**
   * Deepgram diarization: which voice said this (0, 1, 2…). Only set when the
   * transcriber was started with `diarize` and the model tagged the words.
   * The numbering restarts from 0 on every (re)connect — map, don't trust.
   */
  dgSpeaker?: number;
}

export interface Transcriber {
  start(stream: MediaStream | null): Promise<void>;
  stop(): void;
}

type OnEvent = (e: TranscriptEvent) => void;
type OnStatus = (s: "connecting" | "open" | "closed" | "error", detail?: string) => void;

const DG_MODEL = "nova-3";

/**
 * Deepgram live transcription over WebSocket. One instance per audio source
 * (we run one for the tab audio = interviewer, one for the mic = you).
 * Audio is shipped as MediaRecorder webm/opus chunks; Deepgram sniffs the container.
 */
export class DeepgramTranscriber implements Transcriber {
  private ws: WebSocket | null = null;
  private rec: MediaRecorder | null = null;
  private keepAlive: number | null = null;
  private stopped = false;
  private stream: MediaStream | null = null;
  private retry = 0;
  private retryTimer: number | null = null;

  constructor(
    private language: string,
    private onEvent: OnEvent,
    private onStatus: OnStatus,
    /** Split one stream into voices (mic-only capture, where one mic hears both sides). */
    private diarize = false,
  ) {}

  async start(stream: MediaStream | null) {
    if (!stream) return;
    this.stream = stream;
    this.stopped = false;
    this.retry = 0;
    await this.connect();
  }

  /**
   * Re-open the socket after a drop. Joining a call, switching headsets, sleeping the
   * laptop or a brief network stall all close the socket; without this the session went
   * silent for the rest of the interview with nothing on screen to explain it.
   */
  private scheduleReconnect(reason: string) {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = Math.min(8000, 500 * 2 ** this.retry);
    this.retry++;
    this.onStatus("connecting", `reconnecting in ${Math.round(delay / 100) / 10}s (${reason})`);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.connect().catch(() => this.scheduleReconnect("retry failed"));
    }, delay);
  }

  private teardownSocket() {
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
    try { if (this.rec && this.rec.state !== "inactive") this.rec.stop(); } catch { /* ignore */ }
    this.rec = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private async connect() {
    const stream = this.stream;
    if (!stream || this.stopped) return;
    this.teardownSocket();
    // A track that has ended can never produce audio again — the caller must re-capture.
    if (stream.getAudioTracks().every((t) => t.readyState === "ended")) {
      this.onStatus("error", "audio device went away — press Go live again");
      return;
    }
    this.onStatus("connecting");
    const r = await fetch("/api/stt/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepgram", language: this.language }),
    });
    const j = await r.json();
    if (!r.ok) {
      this.onStatus("error", j.error || "Could not get Deepgram token");
      throw new Error(j.error || "stt token failed");
    }
    const params = new URLSearchParams({
      model: DG_MODEL,
      language: this.language === "auto" ? "multi" : this.language,
      smart_format: "true",
      interim_results: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1200",
      vad_events: "true",
      filler_words: "false",
    });
    if (this.diarize) params.set("diarize", "true");
    if (j.warning) console.warn("[parak]", j.warning);
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    const ws = new WebSocket(url, [j.scheme === "bearer" ? "bearer" : "token", j.token]);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Deepgram socket error"));
    }).catch((e) => {
      this.onStatus("error", e.message);
      throw e;
    });
    this.onStatus("open");

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        this.retry = 0; // healthy traffic — reset the backoff
        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0];
          const text: string = alt?.transcript ?? "";
          if (!text) return;
          const words: { word: string; punctuated_word?: string; speaker?: number }[] = alt?.words ?? [];
          if (this.diarize && words.some((w) => w.speaker !== undefined)) {
            if (!msg.is_final) {
              // Interim text repaints in place — label the whole thing by its dominant voice.
              const counts = new Map<number, number>();
              for (const w of words) counts.set(w.speaker ?? 0, (counts.get(w.speaker ?? 0) ?? 0) + 1);
              const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
              this.onEvent({ text, isFinal: false, speechFinal: false, dgSpeaker: top });
              return;
            }
            // Final: one event per consecutive same-voice run. A voice change is an
            // utterance boundary in its own right, so every run but the last is closed.
            const runs: { speaker: number; parts: string[] }[] = [];
            for (const w of words) {
              const sp = w.speaker ?? 0;
              const last = runs[runs.length - 1];
              if (last && last.speaker === sp) last.parts.push(w.punctuated_word ?? w.word);
              else runs.push({ speaker: sp, parts: [w.punctuated_word ?? w.word] });
            }
            runs.forEach((run, i) => {
              this.onEvent({
                text: run.parts.join(" "),
                isFinal: true,
                speechFinal: i < runs.length - 1 || !!msg.speech_final,
                dgSpeaker: run.speaker,
              });
            });
            return;
          }
          this.onEvent({ text, isFinal: !!msg.is_final, speechFinal: !!msg.speech_final });
        } else if (msg.type === "UtteranceEnd") {
          this.onEvent({ text: "", isFinal: true, speechFinal: true });
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
      if (this.stopped) { this.onStatus("closed", ev.reason || `code ${ev.code}`); return; }
      this.scheduleReconnect(ev.reason || `code ${ev.code}`);
    };
    ws.onerror = () => {
      if (!this.stopped) this.scheduleReconnect("socket error");
    };

    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined);
    this.rec = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    rec.onerror = () => { if (!this.stopped) this.scheduleReconnect("recorder error"); };
    // Switching audio device (plugging a headset, joining a call) ends the track.
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => { if (!this.stopped) this.scheduleReconnect("audio track ended"); };
    });
    rec.start(250);
    this.keepAlive = window.setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.keepAlive) clearInterval(this.keepAlive);
    try {
      if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    } catch {
      /* ignore */
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
      this.ws.close();
    }
    this.ws = null;
    this.rec = null;
  }
}

function pickMime(): string | undefined {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return c.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m));
}

/**
 * Zero-key fallback: browser Web Speech API. Chrome-only, microphone only —
 * it cannot hear the shared tab, so put your laptop on speaker or use it for your own side.
 */
export class WebSpeechTranscriber implements Transcriber {
  private rec: SpeechRecognition | null = null;
  private stopped = false;

  constructor(
    private language: string,
    private onEvent: OnEvent,
    private onStatus: OnStatus,
  ) {}

  async start(_stream: MediaStream | null) {
    void _stream;
    const w = window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.onStatus("error", "Web Speech API not available in this browser (use Chrome) — or add a Deepgram key.");
      throw new Error("no web speech");
    }
    this.stopped = false;
    const rec = new Ctor();
    this.rec = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.language === "auto" ? navigator.language : this.language;
    rec.onstart = () => this.onStatus("open");
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.onStatus("error", e.error);
    };
    rec.onend = () => {
      if (!this.stopped) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      } else this.onStatus("closed");
    };
    rec.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0]?.transcript ?? "";
        if (!text) continue;
        this.onEvent({ text: text.trim(), isFinal: res.isFinal, speechFinal: res.isFinal });
      }
    };
    this.onStatus("connecting");
    rec.start();
  }

  stop() {
    this.stopped = true;
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }
}

/** Cheap heuristic: does this utterance look like something the candidate should answer? */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  if (t.split(/\s+/).length < 4) return false;
  return /^(tell me|can you|could you|would you|walk me|describe|explain|what|why|how|when|where|which|who|do you|did you|have you|are you|is there|give me|let's talk|talk about|share|so,? |any experience|what's|whats|how's|hows)/.test(t)
    || /\b(tell me about|walk me through|explain how|how would you|what would you|why did you|describe a time|give an example|how do you|what is your|whats your|what's your)\b/.test(t);
}

/* ------------------------------------------------------------------ OpenAI */

const OPENAI_RT_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

/** Inline AudioWorklet that forwards mono Float32 frames to the main thread. */
const PCM_WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

function floatToPcm16Base64(f32: Float32Array): string {
  const buf = new ArrayBuffer(f32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * OpenAI Realtime transcription (gpt-4o-transcribe) over WebSocket.
 * Audio is resampled to 24 kHz PCM16 in an AudioContext and appended in ~100 ms frames.
 */
export class OpenAIRealtimeTranscriber implements Transcriber {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private partial = new Map<string, string>();

  constructor(
    private language: string,
    private onEvent: OnEvent,
    private onStatus: OnStatus,
  ) {}

  async start(stream: MediaStream | null) {
    if (!stream) return;
    this.onStatus("connecting");
    const r = await fetch("/api/stt/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openai", language: this.language }),
    });
    const j = await r.json();
    if (!r.ok) {
      this.onStatus("error", j.error || "Could not get OpenAI token");
      throw new Error(j.error || "stt token failed");
    }
    const ws = new WebSocket(OPENAI_RT_URL, ["realtime", `openai-insecure-api-key.${j.token}`]);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("OpenAI realtime socket error"));
      ws.onclose = (ev) => reject(new Error(`OpenAI realtime closed (${ev.code}) ${ev.reason || ""}`.trim()));
    }).catch((e) => {
      this.onStatus("error", e.message);
      throw e;
    });
    this.onStatus("open");

    ws.onmessage = (ev) => {
      let msg: { type: string; item_id?: string; delta?: string; transcript?: string; error?: { message?: string; code?: string } };
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      switch (msg.type) {
        case "conversation.item.input_audio_transcription.delta": {
          const id = msg.item_id ?? "x";
          const cur = (this.partial.get(id) ?? "") + (msg.delta ?? "");
          this.partial.set(id, cur);
          this.onEvent({ text: cur, isFinal: false, speechFinal: false });
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const id = msg.item_id ?? "x";
          this.partial.delete(id);
          const text = (msg.transcript ?? "").trim();
          if (text) this.onEvent({ text, isFinal: true, speechFinal: true });
          break;
        }
        case "conversation.item.input_audio_transcription.failed":
        case "error":
          this.onStatus("error", msg.error?.message || "realtime error");
          break;
      }
    };
    ws.onclose = (ev) => this.onStatus("closed", ev.reason || `code ${ev.code}`);
    ws.onerror = () => this.onStatus("error", "socket error");

    // audio → 24k PCM16
    const ctx = new AudioContext({ sampleRate: 24000 });
    this.ctx = ctx;
    const url = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, outputChannelCount: [1] });
    this.src = src;
    this.node = node;
    let acc: Float32Array[] = [];
    let accLen = 0;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      acc.push(e.data);
      accLen += e.data.length;
      if (accLen >= 2400) { // ~100 ms @ 24 kHz
        const merged = new Float32Array(accLen);
        let o = 0;
        for (const a of acc) { merged.set(a, o); o += a.length; }
        acc = []; accLen = 0;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: floatToPcm16Base64(merged) }));
        }
      }
    };
    // Route through a muted gain into the destination: a worklet that reaches the destination
    // keeps being pulled while the tab sits in the background behind the meeting window.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
  }

  stop() {
    try { this.node?.port.close(); this.node?.disconnect(); this.src?.disconnect(); } catch { /* ignore */ }
    this.ctx?.close().catch(() => {});
    this.ctx = null; this.node = null; this.src = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
  }
}

/**
 * OpenAI chunked fallback: restart MediaRecorder every few seconds so each blob is a
 * complete container, POST to /api/stt/transcribe (gpt-4o-mini-transcribe). ~4–6 s latency, no interim text.
 */
export class OpenAIChunkedTranscriber implements Transcriber {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private stopped = false;
  private queue = Promise.resolve();

  constructor(
    private language: string,
    private onEvent: OnEvent,
    private onStatus: OnStatus,
    private chunkMs = 4000,
  ) {}

  async start(stream: MediaStream | null) {
    if (!stream) return;
    this.stream = stream;
    this.stopped = false;
    this.onStatus("open");
    this.cycle();
  }

  private cycle() {
    if (this.stopped || !this.stream) return;
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.rec = rec;
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: mime || "audio/webm" });
      this.queue = this.queue.then(() => this.send(blob)).catch(() => {});
      this.cycle();
    };
    rec.start();
    this.timer = window.setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, this.chunkMs);
  }

  private async send(blob: Blob) {
    if (blob.size < 2000) return;
    const fd = new FormData();
    fd.append("file", blob, "chunk.webm");
    fd.append("language", this.language);
    const r = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) { this.onStatus("error", j.error || "transcribe failed"); return; }
    const text = String(j.text || "").trim();
    if (text) this.onEvent({ text, isFinal: true, speechFinal: true });
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    try { if (this.rec && this.rec.state !== "inactive") this.rec.stop(); } catch { /* ignore */ }
    this.rec = null;
    this.stream = null;
    this.onStatus("closed");
  }
}
