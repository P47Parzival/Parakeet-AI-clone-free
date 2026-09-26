"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { attachLevelMeter, snapshotDisplay, startCapture, type CaptureBundle } from "@/lib/client/audio";
import {
  DeepgramTranscriber, OpenAIChunkedTranscriber, OpenAIRealtimeTranscriber, WebSpeechTranscriber,
  looksLikeQuestion, type Transcriber, type TranscriptEvent,
} from "@/lib/client/stt";
import { answerGate, isSelfEcho, nearlySame } from "@/lib/client/echo";
import { streamJson } from "@/lib/client/sse";
import { usePopOut } from "@/components/PopOut";
import { UsageChips, UsagePanel, useUsage } from "@/components/UsageMeter";
import { LANGUAGES, type Answer, type Session, type SessionNotes, type Settings, type Speaker, type TranscriptLine } from "@/lib/types";

type Status = "idle" | "connecting" | "open" | "closed" | "error";
/** How much of the copilot the floating always-on-top window shows. */
type OverlayMode = "bar" | "full";
type LiveAnswer = Answer & { streaming?: boolean; error?: string };

const CAPTURE_LABEL: Record<Settings["captureMode"], string> = {
  mic: "mic",
  tab: "tab + mic",
  device: "loopback + mic",
};
const CAPTURE_HINT: Record<Settings["captureMode"], string> = {
  mic: "Microphone only — no screen share",
  tab: "Share the meeting tab's audio + mic (starts a screen share)",
  device: "Interviewer audio from your loopback device + mic — no screen share, safe to share your screen with the interviewer",
};

export function SessionView({ id }: { id: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [resumeName, setResumeName] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState<{ them: string; me: string }>({ them: "", me: "" });
  const [answers, setAnswers] = useState<LiveAnswer[]>([]);
  const [notes, setNotes] = useState<SessionNotes | null>(null);
  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [status, setStatus] = useState<{ them: Status; me: Status; detail?: string }>({ them: "idle", me: "idle" });
  const [levels, setLevels] = useState({ them: 0, me: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [banner, setBanner] = useState<string>("");
  const [manualQ, setManualQ] = useState("");
  const [micIs, setMicIs] = useState<Speaker>("me"); // for webspeech mode: who does the mic represent
  /** Deepgram diarization is splitting the single mic stream into voices. */
  const [diarized, setDiarized] = useState(false);
  const [autoAnswer, setAutoAnswer] = useState<Settings["autoAnswer"]>("questions");
  const [hasDisplay, setHasDisplay] = useState(false);
  const [tabAudio, setTabAudio] = useState(false);
  const [notFound, setNotFound] = useState(false);
  /** One-click fix shown next to the banner: restart capture in the given mode. */
  const [bannerAct, setBannerAct] = useState<{ label: string; mode: Settings["captureMode"] } | null>(null);
  /** "I'm speaking" hold — auto-answer stays quiet until it clears. */
  const [hold, setHold] = useState(false);
  const [echoCount, setEchoCount] = useState(0);
  const [phoneUrls, setPhoneUrls] = useState<string[] | null>(null);
  const popout = usePopOut();
  const { report: usage, refresh: refreshUsage } = useUsage(id);
  const [showUsage, setShowUsage] = useState(false);
  const [autoPop, setAutoPop] = useState(() => { try { return typeof window === "undefined" || localStorage.getItem("parak.autoPop") !== "0"; } catch { return true; } });
  const toggleAutoPop = () => { setAutoPop((v) => { try { localStorage.setItem("parak.autoPop", v ? "0" : "1"); } catch { /* ignore */ } return !v; }); };

  const capture = useRef<CaptureBundle | null>(null);
  const transcribers = useRef<Transcriber[]>([]);
  const meterStops = useRef<(() => void)[]>([]);
  const pending = useRef<{ them: { parts: string[]; dg?: number }; me: { parts: string[]; dg?: number } }>({ them: { parts: [] }, me: { parts: [] } });
  /**
   * Diarized voice id → who it is. Deepgram numbers voices per connection (0, 1, 2…),
   * so this map is cleared every time the socket (re)opens. The first voice heard is
   * assumed to be the interviewer (they nearly always speak first); `dgFirstRole`
   * flips when the user hits “swap me/them”, and survives reconnects.
   */
  const dgMap = useRef(new Map<number, Speaker>());
  const dgOrder = useRef<number[]>([]);
  const dgFirstRole = useRef<Speaker>("them");
  const diarizingRef = useRef(false);
  const linesRef = useRef<TranscriptLine[]>([]);
  const lastAnsweredIdx = useRef(0);
  const autoTimer = useRef<number | null>(null);
  const abortAnswer = useRef<(() => void) | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const startedAt = useRef<number>(0);
  const micIsRef = useRef<Speaker>("me");
  const autoRef = useRef<Settings["autoAnswer"]>("questions");
  const languageRef = useRef("en");
  /** Recent answer text — anything the mic hears that matches it is you reading it back. */
  const answersRef = useRef<string[]>([]);
  const lastQuestionRef = useRef("");
  const streamingRef = useRef(false);
  /** Timestamp of the last time the microphone actually carried speech. */
  const lastVoiceAt = useRef(0);
  /** Per-channel voice activity, so a silent channel's output can be recognised as noise. */
  const voiceAt = useRef<Record<Speaker, number>>({ them: 0, me: 0 });
  const heardEver = useRef<Record<Speaker, boolean>>({ them: false, me: false });
  /** When each channel's meter last reported. A stale meter must not be read as silence. */
  const meterAt = useRef<Record<Speaker, number>>({ them: 0, me: 0 });
  /** Mic-only capture has one stream standing in for both speakers. */
  const singleSource = useRef(true);
  const holdRef = useRef(false);
  const liveRef = useRef(false);
  /** Capture mode of the running session, so a dropped device can be re-acquired the same way. */
  const modeRef = useRef<Settings["captureMode"]>("mic");
  const goLiveRef = useRef<((mode?: Settings["captureMode"]) => Promise<void>) | null>(null);
  const recoveringRef = useRef(false);
  const settingsRef = useRef<Settings | null>(null);

  const interimRef = useRef<{ them: string; me: string }>({ them: "", me: "" });
  useEffect(() => { interimRef.current = interim; }, [interim]);
  useEffect(() => { micIsRef.current = micIs; }, [micIs]);
  useEffect(() => { autoRef.current = autoAnswer; }, [autoAnswer]);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  useEffect(() => { holdRef.current = hold; }, [hold]);
  useEffect(() => { liveRef.current = live; }, [live]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => {
    answersRef.current = [...answers].reverse().slice(0, 3).map((a) => a.answer).filter(Boolean);
    streamingRef.current = answers.some((a) => a.streaming);
  }, [answers]);

  // ---------- load ----------
  useEffect(() => {
    (async () => {
      const [sj, st] = await Promise.all([
        fetch(`/api/sessions/${id}`).then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
      ]);
      if (sj.error) { setNotFound(true); return; }
      setSession(sj.session);
      setResumeName(sj.resume?.name ?? null);
      setLines(sj.transcript);
      setAnswers(sj.answers);
      if (sj.session.notes_json) setNotes(JSON.parse(sj.session.notes_json));
      setSettings(st);
      setAutoAnswer(st.autoAnswer);
      languageRef.current = sj.session.language;
      if (st.sttProvider === "webspeech") setMicIs("them");
    })();
  }, [id]);

  // ---------- transcription metering ----------
  // Vendors bill STT by audio minute, so the browser reports how long it streamed.
  useEffect(() => {
    if (!live) return;
    const provider = settingsRef.current?.sttProvider;
    if (!provider || provider === "webspeech") return;
    let last = Date.now();
    const book = () => {
      const seconds = (Date.now() - last) / 1000;
      last = Date.now();
      if (seconds < 1) return;
      fetch("/api/usage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, seconds, sessionId: id }),
      }).then(() => refreshUsage()).catch(() => {});
    };
    const t = window.setInterval(book, 60_000);
    return () => { clearInterval(t); book(); };
  }, [live, id, refreshUsage]);

  // ---------- timer ----------
  useEffect(() => {
    if (!live) return;
    startedAt.current = startedAt.current || Date.now();
    const t = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 1000);
    return () => clearInterval(t);
  }, [live]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines, interim]);

  // ---------- answering ----------
  const runAnswer = useCallback((question: string, kind: "auto" | "manual") => {
    abortAnswer.current?.();
    lastQuestionRef.current = question;
    const tempId = `a-${Date.now()}`;
    const card: LiveAnswer = { id: tempId, session_id: id, question, answer: "", kind, created_at: Date.now(), streaming: true };
    setAnswers((prev) => [...prev, card]);
    const upd = (patch: Partial<LiveAnswer>) => setAnswers((prev) => prev.map((a) => (a.id === tempId ? { ...a, ...patch } : a)));
    abortAnswer.current = streamJson("/api/answer", { sessionId: id, question, kind }, {
      onDelta: (t) => setAnswers((prev) => prev.map((a) => (a.id === tempId ? { ...a, answer: a.answer + t } : a))),
      onDone: (full) => { upd({ answer: full, streaming: false }); refreshUsage(); },
      onError: (msg) => upd({ streaming: false, error: msg }),
    });
  }, [id, refreshUsage]);

  const maybeAutoAnswer = useCallback((latest: string) => {
    const mode = autoRef.current;
    if (mode === "off") return;
    if (mode === "questions" && !looksLikeQuestion(latest)) return;
    const delay = Math.max(300, Number(settingsRef.current?.answerDelayMs ?? 1400) || 1400);
    const guardSpeech = settingsRef.current?.pauseWhileSpeaking !== "off";

    const armedAt = Date.now();
    const fire = () => {
      // Still talking, still streaming, or manually held → wait for the room to settle
      // instead of answering over you. Capped so a noisy line can't stall answers forever.
      const quietFor = Date.now() - lastVoiceAt.current;
      const decision = answerGate({
        live: liveRef.current,
        hold: holdRef.current,
        streaming: streamingRef.current,
        guardSpeech,
        quietForMs: quietFor,
        delayMs: delay,
        waitedMs: Date.now() - armedAt,
      });
      if (decision === "drop") { autoTimer.current = null; return; }
      if (decision === "wait") {
        autoTimer.current = window.setTimeout(fire, Math.max(250, delay - quietFor));
        return;
      }
      const all = linesRef.current;
      // Everything the interviewer said since the last answer (cap ~500 chars), so multi-sentence questions stay whole.
      const since = all.slice(lastAnsweredIdx.current).filter((l) => l.speaker === "them").map((l) => l.text);
      let q = since.join(" ");
      if (q.length > 500) q = q.slice(-500);
      if (!q.trim()) q = latest;
      // The same question re-transcribed (or an echo that slipped the filter) isn't a new question.
      if (nearlySame(q, lastQuestionRef.current)) { lastAnsweredIdx.current = all.length; return; }
      lastAnsweredIdx.current = all.length;
      runAnswer(q, "auto");
    };

    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = window.setTimeout(fire, delay);
  }, [runAnswer]);

  // ---------- transcript handling ----------
  const commitLine = useCallback(async (rawSpeaker: Speaker, text: string, dg?: number) => {
    const t = text.trim();
    if (!t) return;
    // Transcribers hallucinate short plausible sentences out of silence ("This could run
    // any noise."). If this channel carried no audible speech recently, drop it — logging
    // it would also trigger an answer to something nobody said.
    // Only trust that verdict while the meter is actually reporting. If it has gone quiet
    // itself (worklet not up yet, audio thread stalled), fail open — a missing meter must
    // never blackhole the transcript, which is what a background tab used to do.
    const metered = meterStops.current.length > 0 && Date.now() - meterAt.current[rawSpeaker] < 2000;
    const heardRecently = Date.now() - voiceAt.current[rawSpeaker] < 4000;
    if (metered && !heardRecently) return;
    let speaker = rawSpeaker;
    // You reading the copilot's answer out loud comes back through the mic. In mic-only /
    // speaker-on-desk setups it lands on the interviewer channel, and answering it would
    // start an endless self-reply loop. Re-label it as yours and never treat it as a question.
    if (speaker === "them") {
      const mine = linesRef.current.filter((l) => l.speaker === "me").slice(-6).map((l) => l.text);
      if (isSelfEcho(t, { answers: answersRef.current, mine })) {
        speaker = "me";
        setEchoCount((n) => n + 1);
        // The echo proves this diarized voice is you — remember it so the whole voice flips.
        if (dg !== undefined) dgMap.current.set(dg, "me");
      }
    }
    const ts = Date.now();
    const local: TranscriptLine = { id: `tmp-${ts}-${Math.random()}`, session_id: id, speaker, text: t, ts, dg };
    setLines((prev) => [...prev, local]);
    fetch(`/api/sessions/${id}/transcript`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker, text: t, ts }),
    })
      .then((r) => r.json())
      .then((j) => {
        // Adopt the server id so a later “swap me/them” can relabel this row in the DB too.
        if (j?.line?.id) setLines((prev) => prev.map((l) => (l.id === local.id ? { ...l, id: j.line.id } : l)));
      })
      .catch(() => {});
    if (speaker === "them") maybeAutoAnswer(t);
  }, [id, maybeAutoAnswer]);

  const flush = useCallback((speaker: Speaker) => {
    const buf = pending.current[speaker];
    if (!buf.parts.length) return;
    const text = buf.parts.join(" ").replace(/\s+/g, " ");
    const dg = buf.dg;
    pending.current[speaker] = { parts: [] };
    setInterim((p) => ({ ...p, [speaker]: "" }));
    commitLine(speaker, text, dg);
  }, [commitLine]);

  /** Diarized voice id → me/them. First distinct voice = interviewer, second = you. */
  const resolveDg = useCallback((dg: number | undefined, fallback: Speaker): Speaker => {
    if (dg === undefined) return fallback;
    const m = dgMap.current;
    if (!m.has(dg)) {
      const first = dgFirstRole.current;
      const second: Speaker = first === "them" ? "me" : "them";
      m.set(dg, dgOrder.current.length === 1 ? second : first);
      dgOrder.current.push(dg);
    }
    return m.get(dg)!;
  }, []);

  const onEvent = useCallback((fallback: Speaker, ev: TranscriptEvent) => {
    // UtteranceEnd carries no text or voice tag — close out whatever either side has pending.
    if (!ev.text && ev.speechFinal) { flush("them"); flush("me"); return; }
    const speaker = resolveDg(ev.dgSpeaker, fallback);
    if (!ev.isFinal) {
      setInterim((p) => ({ ...p, [speaker]: [...pending.current[speaker].parts, ev.text].join(" ") }));
      return;
    }
    const buf = pending.current[speaker];
    if (ev.text) {
      buf.parts.push(ev.text);
      if (ev.dgSpeaker !== undefined) buf.dg = ev.dgSpeaker;
    }
    if (ev.speechFinal) flush(speaker);
    else setInterim((p) => ({ ...p, [speaker]: buf.parts.join(" ") }));
  }, [flush, resolveDg]);

  /**
   * Diarization guessed who is who from speaking order; if it guessed wrong every line is
   * inverted. One click flips the mapping, every line already on screen, and the DB rows.
   */
  const swapSpeakers = useCallback(() => {
    dgFirstRole.current = dgFirstRole.current === "them" ? "me" : "them";
    const m = dgMap.current;
    for (const [k, v] of m) m.set(k, v === "them" ? "me" : "them");
    const relabel: { them: string[]; me: string[] } = { them: [], me: [] };
    const next = linesRef.current.map((l) => {
      if (l.dg === undefined || !m.has(l.dg)) return l;
      const sp = m.get(l.dg)!;
      if (sp === l.speaker) return l;
      if (!l.id.startsWith("tmp-")) relabel[sp].push(l.id);
      return { ...l, speaker: sp };
    });
    setLines(next);
    setMicIs((v) => (v === "them" ? "me" : "them"));
    if (relabel.them.length || relabel.me.length) {
      fetch(`/api/sessions/${id}/transcript`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(relabel),
      }).catch(() => {});
    }
  }, [id]);

  /** Level meter tap: anything above the noise floor counts as "someone is talking right now". */
  const noteLevel = useCallback((who: Speaker, v: number) => {
    meterAt.current[who] = Date.now();
    if (v > 0.08) {
      lastVoiceAt.current = Date.now();
      voiceAt.current[who] = Date.now();
      heardEver.current[who] = true;
      // One stream carries both sides in mic-only mode, so it vouches for either label.
      if (singleSource.current) {
        voiceAt.current[who === "me" ? "them" : "me"] = Date.now();
      }
    }
    setLevels((l) => ({ ...l, [who]: v }));
  }, []);

  /**
   * Answer NOW — no silence delay, no waiting for the utterance to finalize. Grabs
   * everything the interviewer said since the last answer plus whatever is still
   * mid-transcription, so the hotkey fires the instant a question lands.
   */
  const answerNow = useCallback(() => {
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    const all = linesRef.current;
    // Text that hasn't reached the transcript yet: interim (still changing) supersedes
    // the pending buffer, because the interim string already contains the pending parts.
    const unspoken = (interimRef.current.them || pending.current.them.parts.join(" ")).trim();
    const since = all.slice(lastAnsweredIdx.current).filter((l) => l.speaker === "them").map((l) => l.text);
    let q = [...since, unspoken].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (q.length > 600) q = q.slice(-600);
    // Mark before flushing so the lines the flush commits count as answered.
    lastAnsweredIdx.current = all.length
      + (pending.current.them.parts.length ? 1 : 0)
      + (pending.current.me.parts.length ? 1 : 0);
    flush("them"); flush("me");
    if (!q) q = all.filter((l) => l.speaker === "them").slice(-3).map((l) => l.text).join(" ");
    if (!q) { setBanner("Nothing heard from the interviewer yet."); return; }
    runAnswer(q, "manual");
  }, [flush, runAnswer]);
  const answerNowRef = useRef(answerNow);
  useEffect(() => { answerNowRef.current = answerNow; }, [answerNow]);
  const answerNowStable = useCallback(() => answerNowRef.current(), []);

  const askManual = () => {
    const q = manualQ.trim();
    if (!q) return;
    setManualQ("");
    runAnswer(q, "manual");
  };

  const runVision = useCallback((base64: string, mediaType: string, hint = "") => {
    const tempId = `v-${Date.now()}`;
    const card: LiveAnswer = { id: tempId, session_id: id, question: hint ? `[Screenshot] ${hint}` : "[Screenshot]", answer: "", kind: "vision", created_at: Date.now(), streaming: true };
    setAnswers((prev) => [...prev, card]);
    const upd = (patch: Partial<LiveAnswer>) => setAnswers((prev) => prev.map((a) => (a.id === tempId ? { ...a, ...patch } : a)));
    streamJson("/api/vision", { sessionId: id, image: base64, mediaType, hint }, {
      onDelta: (t) => setAnswers((prev) => prev.map((a) => (a.id === tempId ? { ...a, answer: a.answer + t } : a))),
      onDone: (full) => { upd({ answer: full, streaming: false }); refreshUsage(); },
      onError: (msg) => upd({ streaming: false, error: msg }),
    });
  }, [id, refreshUsage]);

  const screenshot = async () => {
    try {
      let display = capture.current?.display ?? null;
      if (!display || !display.getVideoTracks()[0]?.enabled) {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (capture.current) capture.current.display = display;
        else capture.current = { display, tabAudio: null, micAudio: null, stopAll: () => display?.getTracks().forEach((t) => t.stop()) };
        setHasDisplay(true);
      }
      const shot = await snapshotDisplay(display);
      if (!shot) { setBanner("Could not capture the screen."); return; }
      runVision(shot.base64, shot.mediaType, manualQ.trim());
      setManualQ("");
    } catch (e) {
      setBanner((e as Error).message);
    }
  };

  // paste an image anywhere on the page → vision
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        runVision(url.split(",")[1], file.type, manualQ.trim());
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [runVision, manualQ]);

  // Hold-to-answer hotkey (main window). The pop-out wires its own copy, because it is a
  // separate OS window with its own event loop.
  useEffect(() => {
    const key = settings?.answerHotkey ?? "ctrl";
    if (key === "off") return;
    return attachHoldHotkey(window, key, answerNowStable);
  }, [settings?.answerHotkey, answerNowStable]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter" && !(e.target as HTMLElement)?.closest("input,textarea")) { e.preventDefault(); answerNowStable(); }
      if (mod && e.shiftKey && (e.key === "S" || e.key === "s")) { e.preventDefault(); screenshot(); }
      // Panic hide: closes the floating window outright, so nothing of it can land in a
      // screen recording or a full-screen share. Same keys bring it back.
      if (mod && e.shiftKey && (e.key === "H" || e.key === "h")) {
        e.preventDefault();
        if (popout.isOpen) popout.close();
        else popout.open().catch(() => {});
      }
      // Hold the copilot while you answer out loud.
      if (mod && e.shiftKey && (e.key === "M" || e.key === "m")) { e.preventDefault(); setHold((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popout.isOpen]);

  // Nothing on the interviewer channel after 15 s live is nearly always a capture mistake,
  // not a quiet room — say which one instead of showing an empty transcript.
  useEffect(() => {
    if (!live) return;
    const t = window.setTimeout(() => {
      if (!liveRef.current || heardEver.current.them) return;
      const mode = modeRef.current;
      setBanner(
        mode === "tab"
          ? "No interviewer audio yet. In the share picker choose the meeting's Chrome tab (not “Entire Screen” — macOS gives no audio for that) and tick “Share tab audio”."
          : mode === "device"
            ? "No interviewer audio yet on the loopback device. Check the meeting's output is routed to it (Settings → Audio source)."
            : "No interviewer audio yet. Mic-only mode needs the call on speaker — with headphones the mic never hears the interviewer. In a meeting? Capture the meeting tab's audio instead.",
      );
      setBannerAct({ label: mode === "tab" ? "Re-pick tab" : "Switch to tab + mic", mode: "tab" });
    }, 15000);
    return () => clearTimeout(t);
  }, [live]);

  // ---------- go live / stop ----------
  const goLive = async (mode: Settings["captureMode"] = settings?.captureMode ?? "mic") => {
    if (!settings) return;
    modeRef.current = mode;
    setStarting(true);
    setBanner("");
    setBannerAct(null);
    try {
      const provider = settings.sttProvider;
      const lang = languageRef.current;
      const onStatus = (who: Speaker) => (s: Status, detail?: string) => {
        // Deepgram numbers diarized voices per connection — a fresh socket starts back at
        // 0 with no relation to the old ids, so the learned mapping must not carry over.
        if (who === "me" && s === "open" && diarizingRef.current) {
          dgMap.current.clear();
          dgOrder.current = [];
        }
        setStatus((p) => ({ ...p, [who]: s, detail: detail ?? p.detail }));
      };

      if (provider !== "webspeech") {
        let cap: CaptureBundle;
        if (mode === "device") {
          // Loopback device: the interviewer arrives on a virtual input, so no getDisplayMedia
          // call is made and any screen share you are giving the interviewer is left alone.
          try {
            cap = await startCapture({ tab: false, mic: true, themDeviceId: settings.themDeviceId });
          } catch (e) {
            cap = await startCapture({ tab: false, mic: true, micHearsRoom: true });
            setBanner(`Loopback device unavailable (${(e as Error).message}); mic-only mode. Re-pick the device in Settings.`);
          }
        } else if (mode === "mic") {
          // Mic only: no screen share. The mic hears the room → treat it as the interviewer by default.
          cap = await startCapture({ tab: false, mic: true, micHearsRoom: true });
        } else {
          try {
            cap = await startCapture({ tab: true, mic: true });
          } catch (e) {
            // Screen share denied / unsupported → mic-only mode.
            cap = await startCapture({ tab: false, mic: true, micHearsRoom: true });
            setBanner(`Screen share unavailable (${(e as Error).name}); mic-only mode. Put the call on speaker and set “mic = interviewer”.`);
          }
        }
        capture.current = cap;
        singleSource.current = !(cap.tabAudio && cap.micAudio);
        setHasDisplay(!!cap.display);
        setTabAudio(!!cap.tabAudio);
        if (!cap.micAudio && !cap.tabAudio) throw new Error("No audio source — allow the microphone or share tab audio.");
        if (cap.display && !cap.tabAudio) {
          setBanner("No tab audio shared — tick “Share tab audio” when choosing the meeting tab so I can hear the interviewer.");
          setBannerAct({ label: "Re-pick tab", mode: "tab" });
        }
        // Tab audio carries the interviewer, so the mic is you again — a previous
        // mic-only session may have left this on "them", which would answer your own voice.
        setMicIs(cap.tabAudio ? "me" : "them");
        const ts: Transcriber[] = [];
        // Cloud STT: try the low-latency socket first; OpenAI falls back to chunked Whisper-style uploads.
        const make = async (who: Speaker, stream: MediaStream, onEv: (ev: TranscriptEvent) => void, diarize = false) => {
          if (provider === "deepgram") {
            const t = new DeepgramTranscriber(lang, onEv, onStatus(who), diarize);
            await t.start(stream);
            return t;
          }
          try {
            const t = new OpenAIRealtimeTranscriber(lang, onEv, onStatus(who));
            await t.start(stream);
            return t;
          } catch (e) {
            setBanner(`OpenAI realtime unavailable (${(e as Error).message}); using chunked transcription (slower).`);
            const t = new OpenAIChunkedTranscriber(lang, onEv, onStatus(who));
            await t.start(stream);
            return t;
          }
        };
        if (cap.tabAudio) {
          ts.push(await make("them", cap.tabAudio, (ev) => onEvent("them", ev)));
          meterStops.current.push(attachLevelMeter(cap.tabAudio, (v) => noteLevel("them", v)));
        }
        if (cap.micAudio) {
          // One mic carrying both sides → let Deepgram split the voices apart
          // instead of labelling everything the mic hears as one person.
          const diarizeMic = provider === "deepgram" && !cap.tabAudio;
          diarizingRef.current = diarizeMic;
          dgMap.current.clear();
          dgOrder.current = [];
          dgFirstRole.current = "them";
          setDiarized(diarizeMic);
          ts.push(await make("me", cap.micAudio, (ev) => onEvent(micIsRef.current, ev), diarizeMic));
          meterStops.current.push(attachLevelMeter(cap.micAudio, (v) => noteLevel("me", v)));
        }
        transcribers.current = ts;
        cap.display?.getVideoTracks()[0]?.addEventListener("ended", () => stop());
      } else {
        singleSource.current = true;
        const t = new WebSpeechTranscriber(lang, (ev) => onEvent(micIsRef.current, ev), onStatus("me"));
        await t.start(null);
        transcribers.current = [t];
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
          capture.current = { display: null, tabAudio: null, micAudio: mic, stopAll: () => mic.getTracks().forEach((x) => x.stop()) };
          meterStops.current.push(attachLevelMeter(mic, (v) => noteLevel("me", v)));
        } catch { /* meter optional */ }
      }
      setLive(true);
      if (mode === "tab" && capture.current?.display) {
        setBanner("Tab capture is a screen share — starting or stopping your own share to the interviewer can interrupt it (and vice-versa). Settings → Audio source → “Loopback device” avoids screen sharing entirely.");
      }
      if (autoPop && !popout.isOpen) popout.open().catch(() => {});
    } catch (e) {
      setBanner((e as Error).message || "Could not start capture.");
      stop();
    } finally {
      setStarting(false);
    }
  };

  const stop = useCallback(() => {
    liveRef.current = false;
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null; }
    transcribers.current.forEach((t) => t.stop());
    transcribers.current = [];
    meterStops.current.forEach((f) => f());
    meterStops.current = [];
    capture.current?.stopAll();
    capture.current = null;
    setHasDisplay(false);
    setTabAudio(false);
    setLive(false);
    setDiarized(false);
    diarizingRef.current = false;
    setStatus({ them: "idle", me: "idle" });
    setLevels({ them: 0, me: 0 });
    flush("them"); flush("me");
  }, [flush]);

  useEffect(() => { goLiveRef.current = goLive; });

  // ---------- "can you actually hear them?" check ----------
  // Mic capture cannot hear a call playing through headphones, and browser echo
  // cancellation removes it even on speakers. Say so early rather than silently
  // transcribing room noise for the whole interview.
  useEffect(() => {
    if (!live) return;
    const t = window.setTimeout(() => {
      if (!liveRef.current) return;
      const anySound = heardEver.current.them || heardEver.current.me;
      if (anySound) return;
      setBanner(
        modeRef.current === "mic"
          ? "No audio heard in 20s. A microphone cannot hear a call playing through headphones. Capture the meeting tab's audio, put the call on speaker, or set Settings → Audio source → Loopback device (install BlackHole)."
          : "No audio heard in 20s. Check that the right source is shared and not muted.",
      );
      if (modeRef.current === "mic") setBannerAct({ label: "Switch to tab + mic", mode: "tab" });
    }, 20_000);
    return () => clearTimeout(t);
  }, [live]);

  // ---------- capture watchdog ----------
  // Joining a call, plugging in a headset or letting the laptop sleep ends the audio
  // track. Nothing recovers on its own, so the session used to go quiet for good.
  useEffect(() => {
    if (!live) return;
    const check = async () => {
      const cap = capture.current;
      if (!cap || recoveringRef.current) return;
      const tracks = [...(cap.micAudio?.getAudioTracks() ?? []), ...(cap.tabAudio?.getAudioTracks() ?? [])];
      if (!tracks.length || tracks.some((t) => t.readyState === "live")) return;
      // Re-acquiring a screen share needs a user gesture, so tab mode has to be restarted by hand.
      if (modeRef.current === "tab") {
        setBanner("Audio capture stopped — the shared tab went away. Press Go live again.");
        stop();
        return;
      }
      recoveringRef.current = true;
      setBanner("Audio device changed — reconnecting…");
      try {
        stop();
        await goLiveRef.current?.(modeRef.current);
        setBanner("Reconnected to the microphone.");
      } catch {
        setBanner("Could not reopen the microphone — press Go live again.");
      } finally {
        recoveringRef.current = false;
      }
    };
    const t = window.setInterval(check, 3000);
    navigator.mediaDevices?.addEventListener?.("devicechange", check);
    return () => { clearInterval(t); navigator.mediaDevices?.removeEventListener?.("devicechange", check); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  useEffect(() => () => { transcribers.current.forEach((t) => t.stop()); capture.current?.stopAll(); meterStops.current.forEach((f) => f()); }, []);

  const endSession = async () => {
    if (!confirm("End the session and generate notes?")) return;
    stop();
    setEnding(true);
    const r = await fetch(`/api/sessions/${id}/end`, { method: "POST" });
    const j = await r.json();
    setEnding(false);
    if (j.error) { setBanner(`Notes failed: ${j.error}`); setSession((s) => (s ? { ...s, status: "ended" } : s)); return; }
    setNotes(j.notes);
    setSession(j.session);
  };

  // ---------- render ----------
  const ended = session?.status === "ended";
  const langLabel = useMemo(() => LANGUAGES.find((l) => l.code === session?.language)?.label ?? session?.language, [session]);
  const orderedAnswers = useMemo(() => [...answers].reverse(), [answers]);

  if (notFound) return <div className="p-10"><div className="display text-2xl">Session not found.</div><Link href="/" className="btn mt-4">← Back</Link></div>;
  if (!session || !settings) return <div className="p-10 text-muted">Loading…</div>;
  const hotkeyLabel = settings.answerHotkey === "off" ? "" : settings.answerHotkey === "alt" ? "⌥ Option" : "⌃ Control";

  return (
    <div className="h-screen flex flex-col">
      {/* header */}
      <header className="px-5 py-3 border-b border-line flex items-center gap-4 flex-wrap" style={{ background: "rgba(10,12,16,0.7)", backdropFilter: "blur(10px)" }}>
        <Link href="/" className="btn btn-ghost btn-sm">←</Link>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg truncate">{session.title}</h1>
            {live ? <span className="chip chip-live"><span className="dot dot-pulse" /> live</span> : ended ? <span className="chip">ended</span> : <span className="chip">ready</span>}
          </div>
          <div className="mono text-[11px] text-muted truncate">
            {resumeName ? `résumé: ${resumeName}` : "no résumé"} · {langLabel} · {settings.provider === "openai" ? settings.openaiModel : settings.model} · stt {settings.sttProvider}
          </div>
        </div>
        <div className="flex-1" />
        <SourceMeter label={settings.sttProvider === "webspeech" ? "mic" : "them"} status={settings.sttProvider === "webspeech" ? status.me : status.them} level={settings.sttProvider === "webspeech" ? levels.me : levels.them} color="var(--amber)" />
        {settings.sttProvider !== "webspeech" && <SourceMeter label="me" status={status.me} level={levels.me} color="var(--sky)" />}
        <UsageChips report={usage} onClick={() => setShowUsage((v) => !v)} />
        {popout.isOpen && (
          <div
            className="chip chip-amber flex items-center gap-1 !py-0.5 !pl-2 !pr-1"
            title={popout.pinned
              ? "Pinned: stays above every other app, on whatever screen you drag it to, and never appears in a tab or window share. ⌘/Ctrl+Shift+H hides it instantly."
              : "Floating in a normal window — other apps can cover it. Hit 📍 to pin it on top (needs Chrome/Edge 116+)."}
          >
            <span className="dot dot-pulse" /> {popout.pinned ? "pinned — on top" : "floating"}
            <button
              className="btn btn-ghost btn-sm !px-1.5"
              onClick={() => popout.setPinned(!popout.pinned).catch((e) => setBanner((e as Error).message))}
              title={popout.pinned ? "Unpin — let other windows cover it" : "Pin — keep it above every other app"}
            >
              {popout.pinned ? "📌" : "📍"}
            </button>
            <button className="btn btn-ghost btn-sm !px-1.5" onClick={popout.focus} title="Bring the floating window to the front">focus</button>
            <button className="btn btn-ghost btn-sm !px-1.5" onClick={() => popout.resize(760, 136)} title="Shrink it to a one-line bar">bar</button>
            <button className="btn btn-ghost btn-sm !px-1.5" onClick={popout.close} title="Hide it (⌘/Ctrl+Shift+H)">✕</button>
          </div>
        )}
        <div className="mono text-sm tabular-nums" style={{ color: live ? "var(--mint)" : "var(--muted)" }}>{fmt(elapsed)}</div>
        {!ended && (
          <>
            {!live ? (
              <div className="flex items-center gap-2">
                <button className="btn btn-amber" onClick={() => goLive(settings.captureMode)} disabled={starting} title={CAPTURE_HINT[settings.captureMode]}>
                  {starting ? "Connecting…" : `● Go live · ${CAPTURE_LABEL[settings.captureMode]}`}
                </button>
                {(["device", "mic", "tab"] as const)
                  .filter((m) => m !== settings.captureMode && (m !== "device" || settings.themDeviceId))
                  .map((m) => (
                    <button key={m} className="btn btn-sm" onClick={() => goLive(m)} disabled={starting} title={CAPTURE_HINT[m]}>
                      {CAPTURE_LABEL[m]} instead
                    </button>
                  ))}
              </div>
            ) : (
              <button className="btn" onClick={stop}>■ Pause</button>
            )}
            <button className="btn btn-ghost btn-danger btn-sm" onClick={endSession} disabled={ending}>{ending ? "Writing notes…" : "End & notes"}</button>
          </>
        )}
      </header>

      {showUsage && (
        <div className="px-5 py-4 border-b border-line" style={{ background: "var(--panel)" }}>
          <div className="flex items-center gap-3 mb-3">
            <span className="label !mb-0">Usage &amp; credit</span>
            <div className="flex-1" />
            <button className="btn btn-ghost btn-sm" onClick={() => setShowUsage(false)}>✕</button>
          </div>
          <UsagePanel report={usage} />
        </div>
      )}

      {banner && (
        <div className="px-5 py-2 text-sm flex items-center gap-3" style={{ background: "rgba(244,178,58,0.1)", borderBottom: "1px solid rgba(244,178,58,0.3)" }}>
          <span className="chip chip-amber">notice</span><span className="flex-1">{banner}</span>
          {bannerAct && (
            <button
              className="btn btn-amber btn-sm"
              disabled={starting}
              onClick={() => {
                const act = bannerAct;
                setBanner(""); setBannerAct(null);
                stop();
                goLiveRef.current?.(act.mode);
              }}
            >
              {bannerAct.label}
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => { setBanner(""); setBannerAct(null); }}>✕</button>
        </div>
      )}
      {status.detail && (status.them === "error" || status.me === "error") && (
        <div className="px-5 py-2 text-sm" style={{ background: "rgba(255,106,122,0.08)", borderBottom: "1px solid rgba(255,106,122,0.3)", color: "var(--rose)" }}>
          Transcription error: {status.detail}
        </div>
      )}

      {ended && notes && <NotesPanel notes={notes} />}

      {/* body */}
      <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(320px,2fr)_3fr]">
        {/* transcript */}
        <section className="min-h-0 flex flex-col border-r border-line">
          <div className="px-5 py-2 flex items-center gap-3 border-b border-line">
            <span className="label !mb-0">Transcript</span>
            <span className="mono text-[11px] text-dim">{lines.length} lines</span>
            <div className="flex-1" />
            {diarized && !ended && (
              <button
                className="btn btn-sm"
                onClick={swapSpeakers}
                title="Voices are being separated automatically (first voice heard = interviewer). If the labels came out backwards, this flips every line at once."
              >
                ⇄ swap me/them
              </button>
            )}
            {(settings.sttProvider === "webspeech" || (live && !tabAudio && !diarized)) && !ended && (
              <button className="btn btn-sm" onClick={() => setMicIs((m) => (m === "them" ? "me" : "them"))} title="Who is speaking into this microphone?">
                mic = {micIs === "them" ? "interviewer" : "me"} ⇄
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto scroll-thin px-5 py-3">
            {lines.length === 0 && !interim.them && !interim.me && (
              <div className="text-muted text-sm mt-6 space-y-2">
                {settings.sttProvider !== "webspeech" && settings.captureMode === "mic" ? (
                  <>
                    <p><b className="text-ink">Go live · mic</b> — no screen share. The microphone hears the room and the voices are separated automatically: the first voice heard becomes the <span style={{ color: "var(--amber)" }}>interviewer</span>, the second becomes <span style={{ color: "var(--sky)" }}>you</span>.</p>
                    <p>On a call? Put it on speaker — with headphones the mic can&apos;t hear the other side; use <b className="text-ink">tab + mic</b> instead. Practising alone? Just ask yourself a question out loud.</p>
                    <p>If the labels come out backwards, hit <b className="text-ink">⇄ swap me/them</b> above the transcript — it flips everything at once.</p>
                  </>
                ) : settings.sttProvider !== "webspeech" ? (
                  <>
                    <p><b className="text-ink">Go live</b>, pick your <b className="text-ink">meeting tab</b> (Zoom web, Meet, Teams…) and tick <b className="text-ink">Share tab audio</b>.</p>
                    <p>Interviewer audio → <span style={{ color: "var(--amber)" }}>them</span>. Your mic → <span style={{ color: "var(--sky)" }}>me</span>.</p>
                  </>
                ) : (
                  <p>Browser mode listens to your microphone only. Put the call on speaker so it hears the interviewer, and set <b className="text-ink">mic = interviewer</b>.</p>
                )}
                <p className="mono text-xs text-dim">hold ⌃ — answer instantly, even mid-sentence · ⌘/Ctrl+Enter — same · ⌘/Ctrl+Shift+S — screenshot &amp; solve · paste image anywhere</p>
              </div>
            )}
            {lines.map((l) => (
              <div key={l.id} className={`tline ${l.speaker}`}>
                <span className="who">{l.speaker === "them" ? "them" : "me"}</span>
                <span className="txt">{l.text}</span>
              </div>
            ))}
            {interim.them && <div className="tline them interim"><span className="who">them</span><span className="txt">{interim.them}</span></div>}
            {interim.me && <div className="tline me interim"><span className="who">me</span><span className="txt">{interim.me}</span></div>}
            <div ref={transcriptEnd} />
          </div>
        </section>

        {/* answers */}
        <section className="min-h-0 flex flex-col">
          <div className="px-5 py-2 flex items-center gap-2 border-b border-line flex-wrap">
            <span className="label !mb-0">Copilot</span>
            <div className="flex-1" />
            {!ended && (
              <>
                <select className="select !w-auto !py-1 !text-xs" value={autoAnswer} onChange={(e) => setAutoAnswer(e.target.value as Settings["autoAnswer"])} title="Auto-answer">
                  <option value="questions">auto: questions</option>
                  <option value="always">auto: everything</option>
                  <option value="off">auto: off</option>
                </select>
                <button
                  className={`btn btn-sm ${hold ? "btn-amber" : ""}`}
                  onClick={() => setHold((v) => !v)}
                  title="⌘/Ctrl+Shift+M — hold auto-answer while you speak. Nothing you say while held is treated as a question."
                >
                  {hold ? "⏸ holding — I'm speaking" : "⏸ Hold while I speak"}
                </button>
                {echoCount > 0 && (
                  <span className="chip" title="Lines that matched the copilot's own answer and were re-labelled as you instead of answered again">
                    echo × {echoCount}
                  </span>
                )}
                <button className="btn btn-sm" onClick={answerNowStable} title={`⌘/Ctrl+Enter${hotkeyLabel ? ` or hold ${hotkeyLabel}` : ""} — answers instantly, even mid-sentence`}>⚡ Answer now</button>
                <button
                  className="btn btn-sm"
                  onClick={() => popout.open().catch((e) => setBanner((e as Error).message))}
                  title={popout.supported
                    ? "Floating always-on-top window with the answers (Chrome PiP). It is a separate OS window, so sharing a tab or a single window never shows it. ⌘/Ctrl+Shift+H hides it instantly."
                    : "Opens a small popup window (no Chrome PiP support here)"}
                >
                  ⧉ {popout.isOpen ? (popout.pinned ? "Pinned — on top" : "Floating") : "Pop out"}
                </button>
                <label className="chip cursor-pointer select-none" title="Open the floating window automatically when you go live">
                  <input type="checkbox" className="accent-amber-500" checked={autoPop} onChange={toggleAutoPop} /> auto
                </label>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    if (phoneUrls) { setPhoneUrls(null); return; }
                    try {
                      const j = await fetch("/api/lan").then((r) => r.json());
                      setPhoneUrls((j.urls as string[]).map((u) => `${u}/live/${id}`));
                    } catch { setPhoneUrls([]); }
                  }}
                  title="Read the answers on your phone — the one place a screen share can never reach"
                >
                  📱 Phone view
                </button>
                <button className="btn btn-sm" onClick={screenshot} title="⌘/Ctrl+Shift+S">{hasDisplay ? "📷 Screenshot → solve" : "📷 Pick screen → solve"}</button>
              </>
            )}
          </div>
          {phoneUrls && (
            <div className="px-5 py-3 border-b border-line text-sm" style={{ background: "rgba(93,214,178,0.06)" }}>
              <p className="mb-2">Open one of these on your phone. It is a different device, so nothing you share on this machine can ever show it:</p>
              {phoneUrls.length === 0 ? (
                <p style={{ color: "var(--amber)" }}>No LAN address found. Start Parak with <code className="mono">npm run dev:lan</code> and make sure the phone is on the same Wi-Fi.</p>
              ) : (
                <ul className="space-y-1">
                  {phoneUrls.map((u) => (
                    <li key={u} className="mono text-[13px] flex items-center gap-2">
                      <span style={{ color: "var(--mint)" }}>{u}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(u)}>copy</button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted mt-2">Server must be running as <code className="mono">npm run dev:lan</code> for the phone to reach it. Anyone on the same network who knows the session id can open this page.</p>
            </div>
          )}
          {!ended && (
            <form className="px-5 py-3 border-b border-line flex gap-2" onSubmit={(e) => { e.preventDefault(); askManual(); }}>
              <input className="input" placeholder="Type a question or a hint for the copilot… (Enter)" value={manualQ} onChange={(e) => setManualQ(e.target.value)} />
              <button className="btn btn-amber" type="submit" disabled={!manualQ.trim()}>Ask</button>
            </form>
          )}
          <div className="flex-1 overflow-y-auto scroll-thin px-5 py-4 space-y-4">
            {orderedAnswers.length === 0 && (
              <div className="text-muted text-sm mt-6">
                Answers appear here, newest first, streamed as they&apos;re written. Auto-answer fires when the interviewer asks a question.
              </div>
            )}
            {orderedAnswers.map((a, i) => <AnswerCard key={a.id} a={a} latest={i === 0} />)}
          </div>
        </section>
      </div>

      <popout.Portal>
        <OverlayPanel
          live={live}
          elapsed={elapsed}
          lastThem={[...lines].reverse().find((l) => l.speaker === "them")?.text ?? interim.them}
          interimThem={interim.them}
          answers={orderedAnswers}
          hold={hold}
          onHold={() => setHold((v) => !v)}
          onAnswerLast={answerNowStable}
          hotkey={settings.answerHotkey ?? "ctrl"}
          level={levels.them}
          onScreenshot={screenshot}
          onAsk={(q) => runAnswer(q, "manual")}
          onClose={popout.close}
          onResize={popout.resize}
          pinned={popout.pinned}
          pinSupported={popout.supported}
          canDrag={popout.canDrag}
          onPin={(on) => popout.setPinned(on).catch((e) => setBanner((e as Error).message))}
          onMoveBy={popout.moveBy}
        />
      </popout.Portal>
    </div>
  );
}

/**
 * Fire `fire()` when the modifier is held on its own for ~⅓s. Any other key, a mouse
 * click (⌃-click is the Mac context menu) or losing focus cancels the hold, so normal
 * shortcuts and text editing never trigger it.
 */
function attachHoldHotkey(win: Window, key: "ctrl" | "alt", fire: () => void): () => void {
  const wanted = key === "ctrl" ? "Control" : "Alt";
  let timer: number | null = null;
  const cancel = () => { if (timer !== null) { win.clearTimeout(timer); timer = null; } };
  const down = (e: KeyboardEvent) => {
    if (e.key === wanted) {
      if (!e.repeat && timer === null) timer = win.setTimeout(() => { timer = null; fire(); }, 350);
    } else cancel();
  };
  const up = (e: KeyboardEvent) => { if (e.key === wanted) cancel(); };
  win.addEventListener("keydown", down);
  win.addEventListener("keyup", up);
  win.addEventListener("mousedown", cancel);
  win.addEventListener("blur", cancel);
  return () => {
    cancel();
    win.removeEventListener("keydown", down);
    win.removeEventListener("keyup", up);
    win.removeEventListener("mousedown", cancel);
    win.removeEventListener("blur", cancel);
  };
}

/** Sizes the floating window takes in each mode. */
const OVERLAY_SIZES: Record<OverlayMode, { w: number; h: number }> = {
  bar: { w: 760, h: 136 },
  full: { w: 720, h: 660 },
};

/** Shared styles for the ParakeetAI-style stacked bars. */
const P_PANEL: React.CSSProperties = {
  background: "rgba(28, 28, 31, 0.96)",
  border: "1px solid rgba(255,255,255,0.09)",
  borderRadius: 18,
  boxShadow: "0 18px 50px -12px rgba(0,0,0,0.65)",
  color: "#f2f2f4",
};
const P_PILL: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 999, padding: "6px 12px", fontSize: 13, fontWeight: 500, lineHeight: "18px",
  color: "#f2f2f4", cursor: "pointer", whiteSpace: "nowrap",
};
const P_ICON: React.CSSProperties = { ...P_PILL, padding: "6px 9px" };

function Kbd({ k }: { k: string }) {
  return (
    <span style={{ background: "rgba(255,255,255,0.14)", borderRadius: 5, padding: "1px 5px", fontSize: 10, lineHeight: "14px", fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "rgba(255,255,255,0.75)" }}>
      {k}
    </span>
  );
}

/** Little green voice-level indicator, like a live-caption chip. */
function LevelBars({ level, live }: { level: number; live: boolean }) {
  const hs = [7, 13, 9].map((base) => Math.min(16, base + level * 24));
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, height: 16, marginRight: 2 }} title={live ? "Listening" : "Paused"}>
      {hs.map((h, i) => (
        <i key={i} style={{ width: 3, height: live ? h : 4, borderRadius: 2, background: live ? "#34c759" : "rgba(255,255,255,0.25)", transition: "height 120ms" }} />
      ))}
    </span>
  );
}

/**
 * Floating always-on-top copilot, styled after the ParakeetAI overlay: a rounded
 * control bar (pill buttons + keyboard chips), a live-caption strip with what the
 * interviewer is saying, and a Question/Answer card with ⌘←/⌘→ history.
 */
function OverlayPanel({ live, elapsed, lastThem, interimThem, answers, hold, onHold, onAnswerLast, onAsk, onClose, onResize, pinned, pinSupported, canDrag, onPin, onMoveBy, hotkey, level, onScreenshot }: {
  live: boolean; elapsed: number; lastThem: string; interimThem: string; answers: LiveAnswer[];
  hold: boolean; onHold: () => void;
  onAnswerLast: () => void; onAsk: (q: string) => void; onClose: () => void; onResize: (w: number, h: number) => void;
  pinned: boolean; pinSupported: boolean; canDrag: boolean;
  onPin: (on: boolean) => void; onMoveBy: (dx: number, dy: number) => boolean;
  hotkey: "ctrl" | "alt" | "off"; level: number; onScreenshot: () => void;
}) {
  const [q, setQ] = useState("");
  const askRef = useRef<HTMLInputElement>(null);
  // The panel lives in its own OS window when popped out — the hold-to-answer hotkey
  // must listen there too, or it only works while the main tab has focus.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hotkey === "off") return;
    const win = rootRef.current?.ownerDocument?.defaultView;
    if (!win || win === window) return; // rendered inline in the main tab, already wired
    return attachHoldHotkey(win, hotkey, onAnswerLast);
  }, [hotkey, onAnswerLast]);

  // Kept in localStorage because pinning swaps the OS window, which remounts this panel.
  const [opacity, setOpacity] = useState(() => num("parak.popout.opacity", 1));
  const [scale, setScale] = useState(() => num("parak.popout.scale", 1));
  useEffect(() => { try { localStorage.setItem("parak.popout.opacity", String(opacity)); } catch { /* ignore */ } }, [opacity]);
  useEffect(() => { try { localStorage.setItem("parak.popout.scale", String(scale)); } catch { /* ignore */ } }, [scale]);
  const [menu, setMenu] = useState(false);
  const [pinHint, setPinHint] = useState("");
  /**
   * The pin lives in the overlay window, but the window it creates must be requested by the
   * main tab — and a click in here does not give the main tab a user activation. Say so
   * instead of firing a request the browser will refuse.
   */
  const tryPin = () => {
    if (!pinSupported) {
      setPinHint("Always-on-top needs Chrome or Edge 116+ (Document Picture-in-Picture). This browser can only show a normal window.");
      return;
    }
    if (!(navigator.userActivation?.isActive ?? true)) {
      setPinHint(`Click 📌 in Parak's top bar — browsers only ${pinned ? "unpin" : "pin"} from a click in the main tab. Bringing it to the front…`);
      window.focus();
      return;
    }
    setPinHint("");
    onPin(!pinned);
  };

  // Drag the window from the overlay's own grip. Only script-opened popups may be moved;
  // a pinned PiP window is dragged by its title bar instead.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const startDrag = (e: React.PointerEvent) => {
    if (!canDrag) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY };
  };
  const onDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX - d.x, dy = e.screenY - d.y;
    if (!dx && !dy) return;
    drag.current = { x: e.screenX, y: e.screenY };
    onMoveBy(dx, dy);
  };
  const endDrag = (e: React.PointerEvent) => {
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const [mode, setMode] = useState<OverlayMode>(() => {
    try {
      const m = localStorage.getItem("parak.popout.mode");
      return m === "bar" ? "bar" : "full"; // old "compact" collapses into "full"
    } catch { return "full"; }
  });
  const setModeAndSize = (m: OverlayMode) => {
    setMode(m);
    try { localStorage.setItem("parak.popout.mode", m); } catch { /* ignore */ }
    onResize(OVERLAY_SIZES[m].w, OVERLAY_SIZES[m].h);
  };
  const bar = mode === "bar";

  // ⌘←/⌘→ page through past answers; a new answer always snaps back to the latest
  // (the stored index is keyed to the latest answer's id, so a new arrival resets it).
  const [nav, setNav] = useState<{ latest: string | undefined; idx: number }>({ latest: undefined, idx: 0 });
  const latestId = answers[0]?.id;
  const idx = nav.latest === latestId ? nav.idx : 0;
  const setIdx = useCallback((f: (i: number) => number) => {
    setNav((n) => {
      const cur = n.latest === latestId ? n.idx : 0;
      return { latest: latestId, idx: f(cur) };
    });
  }, [latestId]);
  const current = answers[Math.min(idx, Math.max(0, answers.length - 1))];
  const [clearedAnswerId, setClearedAnswerId] = useState<string | null>(null);
  const [clearedThem, setClearedThem] = useState("");
  const themText = interimThem || lastThem;
  const shownThem = themText && themText !== clearedThem ? themText : "";
  const showAnswer = current && current.id !== clearedAnswerId;

  useEffect(() => {
    const win = rootRef.current?.ownerDocument?.defaultView;
    if (!win || win === window) return; // don't hijack ⌘← (browser back) in the main tab
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); setIdx((i) => Math.min(i + 1, Math.max(0, answers.length - 1))); }
      if (e.key === "ArrowRight") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      if (e.key === "Backspace" && !(e.target as HTMLElement)?.closest("input,textarea")) { e.preventDefault(); setClearedAnswerId(current?.id ?? null); }
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [answers.length, current?.id, setIdx]);

  const mod = "⌘";
  return (
    <div ref={rootRef} className="h-full flex flex-col" style={{ background: "#0b0c10", color: "#f2f2f4", fontFamily: "var(--font-body)", opacity, fontSize: `${scale}rem`, padding: 10, gap: 9 }}>
      {/* ---- control bar ---- */}
      <div style={{ ...P_PANEL, display: "flex", alignItems: "center", gap: 7, padding: "7px 9px", flexWrap: "wrap" }}>
        <span
          style={{ cursor: canDrag ? "grab" : "default", touchAction: "none", padding: "0 3px", color: "rgba(255,255,255,0.55)", fontSize: 15 }}
          onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
          title={canDrag ? "Drag the window anywhere on any screen" : "Pinned windows are dragged by their own title bar"}
        >✥</span>
        <span style={{ display: "inline-flex", gap: 5, alignItems: "center", marginRight: 2 }}>
          <span className={live ? "dot dot-pulse" : "dot"} style={{ color: live ? "#ff453a" : "rgba(255,255,255,0.3)" }} />
          <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "rgba(255,255,255,0.55)" }}>{fmt(elapsed)}</span>
        </span>
        <button style={P_PILL} onClick={onAnswerLast} title={`Answer instantly — even mid-sentence${hotkey !== "off" ? `. Or hold ${hotkey === "alt" ? "⌥" : "⌃"} on its own` : ""}`}>
          Answer <Kbd k={`${mod}↵`} />{hotkey !== "off" && <Kbd k={`hold ${hotkey === "alt" ? "⌥" : "⌃"}`} />}
        </button>
        <button style={P_PILL} onClick={onScreenshot} title="Screenshot the shared screen and solve it">
          Screenshot <Kbd k={`${mod}⇧S`} />
        </button>
        <button style={P_PILL} onClick={() => { if (bar) setModeAndSize("full"); askRef.current?.focus(); }} title="Type a question or a hint for the copilot">
          Chat
        </button>
        <button style={{ ...P_PILL, ...(hold ? { background: "rgba(244,178,58,0.25)", borderColor: "rgba(244,178,58,0.5)" } : {}) }} onClick={onHold} title="Hold auto-answer while you speak (⌘/Ctrl+Shift+M)">
          {hold ? "⏸ held" : "⏸"}
        </button>
        <div style={{ flex: 1 }} />
        <button style={{ ...P_ICON, ...(pinned ? { background: "rgba(244,178,58,0.25)", borderColor: "rgba(244,178,58,0.5)" } : {}) }} onClick={tryPin}
          title={!pinSupported ? "Pinning needs Chrome or Edge 116+ (Document Picture-in-Picture)" : pinned ? "Pinned — stays above every other app. Click to unpin." : "Pin — keep this window above every other app"}>
          {pinned ? "📌" : "📍"}
        </button>
        <button style={P_ICON} onClick={() => setModeAndSize(bar ? "full" : "bar")} title={bar ? "Expand — show the answer card" : "Collapse to a strip"}>
          {bar ? "⤢" : "⤡"}
        </button>
        <button style={P_ICON} onClick={() => setMenu((m) => !m)} title="Opacity & text size">⋮</button>
        <button style={{ ...P_PILL, background: "#e5484d", borderColor: "#e5484d", color: "#fff" }} onClick={onClose} title="Hide this window instantly (⌘/Ctrl+Shift+H) — same keys bring it back">
          Hide
        </button>
      </div>

      {menu && (
        <div style={{ ...P_PANEL, display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", fontSize: 12 }}>
          <span style={{ color: "rgba(255,255,255,0.55)" }}>opacity</span>
          <input type="range" min={0.4} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} style={{ width: 90, accentColor: "#f4b23a" }} />
          <span style={{ color: "rgba(255,255,255,0.55)" }}>text</span>
          <button style={P_ICON} onClick={() => setScale((v) => Math.max(0.8, +(v - 0.1).toFixed(1)))}>A−</button>
          <button style={P_ICON} onClick={() => setScale((v) => Math.min(1.5, +(v + 0.1).toFixed(1)))}>A+</button>
          <div style={{ flex: 1 }} />
          <button style={P_ICON} onClick={() => setMenu(false)}>✕</button>
        </div>
      )}
      {pinHint && (
        <div style={{ ...P_PANEL, padding: "7px 12px", fontSize: 12, color: "#f4b23a", display: "flex", gap: 8 }}>
          <span style={{ flex: 1 }}>{pinHint}</span>
          <button style={P_ICON} onClick={() => setPinHint("")}>✕</button>
        </div>
      )}

      {/* ---- live caption strip ---- */}
      <div style={{ ...P_PANEL, display: "flex", alignItems: "center", gap: 9, padding: "8px 13px", minHeight: 38 }}>
        <LevelBars level={level} live={live} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14, color: shownThem ? "#f2f2f4" : "rgba(255,255,255,0.4)", fontStyle: interimThem && shownThem ? "italic" : "normal" }}>
          {shownThem || (live ? "…listening" : "paused")}
        </span>
        <button style={P_PILL} onClick={() => setClearedThem(themText)} title="Clear the caption">
          Clear <Kbd k={`${mod}⇧⌫`} />
        </button>
      </div>

      {/* ---- answer card ---- */}
      {!bar && (
        <div style={{ ...P_PANEL, flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px 0" }}>
            <button style={P_ICON} onClick={() => setIdx((i) => Math.min(i + 1, Math.max(0, answers.length - 1)))} disabled={idx >= answers.length - 1} title="Older answer">
              <Kbd k={`${mod}←`} />
            </button>
            <button style={P_ICON} onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} title="Newer answer">
              <Kbd k={`${mod}→`} />
            </button>
            {idx > 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{idx + 1}/{answers.length}</span>}
            <div style={{ flex: 1 }} />
            <button style={P_PILL} onClick={() => setClearedAnswerId(current?.id ?? null)} title="Clear this answer from view">
              Clear <Kbd k={`${mod}⌫`} />
            </button>
            <button style={P_ICON} onClick={() => { if (current) navigator.clipboard?.writeText(current.answer); }} title="Copy the answer">⧉</button>
          </div>
          <div className="scroll-thin" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 16px 12px" }}>
            {!showAnswer && (
              <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, marginTop: 8 }}>
                Answers appear here when the interviewer asks a question — or press Answer.
              </div>
            )}
            {showAnswer && current && (
              <>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <span>💬</span>
                  <span style={{ fontSize: 14, color: "rgba(255,255,255,0.8)" }}>
                    <b>Question:</b> <span style={{ color: "rgba(255,255,255,0.6)" }}>{current.question}</span>
                  </span>
                </div>
                {current.error && <div style={{ color: "#ff6a7a", fontSize: 14 }}>{current.error}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <span>⭐</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ fontSize: 14 }}>Answer:</b>
                    <div className={`md ${current.streaming ? "cursor" : ""}`} style={{ fontSize: "0.97rem", marginTop: 4 }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{current.answer}</ReactMarkdown>
                    </div>
                    {current.streaming && !current.answer && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", fontFamily: "ui-monospace, monospace" }}>thinking…</div>}
                    {!current.streaming && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "rgba(255,255,255,0.4)" }}>
                        {current.kind} · {new Date(current.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          <form
            style={{ display: "flex", gap: 8, padding: "9px 10px", borderTop: "1px solid rgba(255,255,255,0.08)" }}
            onSubmit={(e) => { e.preventDefault(); if (q.trim()) { onAsk(q.trim()); setQ(""); } }}
          >
            <input
              ref={askRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask the copilot…"
              style={{ flex: 1, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 999, padding: "7px 14px", fontSize: 13, color: "#f2f2f4", outline: "none" }}
            />
            <button type="submit" disabled={!q.trim()} style={{ ...P_PILL, background: "rgba(244,178,58,0.9)", borderColor: "transparent", color: "#161616" }}>Ask</button>
          </form>
        </div>
      )}
    </div>
  );
}

function SourceMeter({ label, status, level, color }: { label: string; status: Status; level: number; color: string }) {
  const c = status === "open" ? "var(--mint)" : status === "error" ? "var(--rose)" : status === "connecting" ? "var(--amber)" : "var(--dim)";
  return (
    <div className="hidden sm:flex flex-col gap-1 w-24">
      <div className="mono text-[10px] tracking-widest uppercase flex items-center gap-1" style={{ color }}>
        <span className={`dot ${status === "open" ? "dot-pulse" : ""}`} style={{ color: c }} /> {label}
      </div>
      <div className="meter"><i style={{ width: `${Math.round(level * 100)}%` }} /></div>
    </div>
  );
}

function AnswerCard({ a, latest }: { a: LiveAnswer; latest: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(a.answer); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <article className="panel p-4 rise" style={latest ? { borderColor: "rgba(244,178,58,0.35)", boxShadow: "0 0 0 1px rgba(244,178,58,0.15), 0 30px 60px -40px rgba(244,178,58,0.5)" } : undefined}>
      <div className="flex items-start gap-3 mb-2">
        <span className={`chip ${a.kind === "vision" ? "chip-amber" : a.kind === "auto" ? "chip-live" : ""}`}>{a.kind}</span>
        <div className="text-sm text-muted flex-1 min-w-0 line-clamp-2" title={a.question}>{a.question}</div>
        <span className="mono text-[10px] text-dim">{new Date(a.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <button className="btn btn-ghost btn-sm" onClick={copy}>{copied ? "copied" : "copy"}</button>
      </div>
      {a.error && <div className="text-sm" style={{ color: "var(--rose)" }}>{a.error}</div>}
      <div className={`md ${a.streaming ? "cursor" : ""}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.answer || (a.streaming ? "" : "")}</ReactMarkdown>
      </div>
      {a.streaming && !a.answer && <div className="mono text-xs text-muted">thinking…</div>}
    </article>
  );
}

function NotesPanel({ notes }: { notes: SessionNotes }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-line" style={{ background: "rgba(244,178,58,0.04)" }}>
      <button className="w-full px-5 py-2 flex items-center gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="chip chip-amber">post-call notes</span>
        <span className="text-sm text-muted flex-1 truncate">{notes.summary}</span>
        <span className="mono text-xs text-dim">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="px-5 pb-5 grid md:grid-cols-2 xl:grid-cols-4 gap-4 max-h-[45vh] overflow-y-auto scroll-thin">
          <NotesBlock title="Summary"><p>{notes.summary}</p></NotesBlock>
          <NotesBlock title="Questions asked">
            <ol className="list-decimal pl-4 space-y-1">{notes.questions.map((q, i) => <li key={i}><b>{q.question}</b><div className="text-muted">{q.how_it_went}</div></li>)}</ol>
          </NotesBlock>
          <NotesBlock title="Strengths / improve">
            <ul className="list-disc pl-4 space-y-1">{notes.strengths.map((s, i) => <li key={`s${i}`} style={{ color: "var(--mint)" }}><span className="text-ink">{s}</span></li>)}</ul>
            <ul className="list-disc pl-4 space-y-1 mt-2">{notes.improvements.map((s, i) => <li key={`i${i}`} style={{ color: "var(--ember)" }}><span className="text-ink">{s}</span></li>)}</ul>
          </NotesBlock>
          <NotesBlock title="Action items + email">
            <ul className="list-disc pl-4 space-y-1">{notes.action_items.map((s, i) => <li key={i}>{s}</li>)}</ul>
            {notes.follow_up_email && <pre className="mono text-xs whitespace-pre-wrap mt-3 p-2 rounded-lg" style={{ background: "#070910", border: "1px solid var(--line)" }}>{notes.follow_up_email}</pre>}
          </NotesBlock>
        </div>
      )}
    </section>
  );
}

function NotesBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-3 text-sm">
      <div className="label">{title}</div>
      {children}
    </div>
  );
}

function num(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function fmt(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
