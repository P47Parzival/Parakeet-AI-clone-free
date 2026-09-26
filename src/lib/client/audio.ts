"use client";

export interface CaptureBundle {
  /** Audio coming from the shared tab/window (the interviewer). Null if user didn't share audio. */
  tabAudio: MediaStream | null;
  /** Microphone (you). Null if denied / not requested. */
  micAudio: MediaStream | null;
  /** The shared display stream (used for screenshots). */
  display: MediaStream | null;
  stopAll(): void;
}

/** Audio input devices, for picking a loopback device (BlackHole, VB-Cable, Loopback…) as the interviewer channel. */
export async function listAudioInputs(): Promise<MediaDeviceInfo[]> {
  // Labels are empty until the page has been granted mic access once.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    /* labels may stay blank; ids still work */
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audioinput");
}

/** Device names that are loopback/virtual outputs re-entering as inputs. */
const LOOPBACK_HINT = /blackhole|loopback|vb-?cable|virtual|soundflower|voicemeeter|aggregate|multi-?output|stereo mix|what ?u ?hear/i;

export function looksLikeLoopback(label: string) {
  return LOOPBACK_HINT.test(label);
}

/**
 * Ask for a screen/tab share (with audio) and the microphone.
 * In Chrome, pick the meeting *tab* and tick "Share tab audio" so we hear the interviewer.
 *
 * `themDeviceId` takes priority over `tab`: the interviewer channel is read from a loopback
 * input device instead, so Parak never calls getDisplayMedia and can never disturb a screen
 * share you are giving the interviewer.
 */
export async function startCapture(opts: {
  mic: boolean;
  tab: boolean;
  themDeviceId?: string;
  /**
   * True when the microphone is the only source, so it has to carry the interviewer too.
   * Browser echo cancellation exists to subtract speaker output from the mic — exactly the
   * interviewer's voice — so it must be off, or the one thing we need is filtered away.
   */
  micHearsRoom?: boolean;
}): Promise<CaptureBundle> {
  let display: MediaStream | null = null;
  let tabAudio: MediaStream | null = null;
  let micAudio: MediaStream | null = null;

  if (opts.themDeviceId) {
    tabAudio = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: opts.themDeviceId },
        // Loopback audio is already clean; processing it only chews away at the voice.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } else if (opts.tab) {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // Keep the meeting audible to the user while we capture it.
        suppressLocalAudioPlayback: false,
      },
      // Chrome-only hints below (hence the cast).
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      // "Entire Screen" yields no audio on macOS — hide it from the picker so the
      // meeting tab (the only surface that carries audio there) is what gets picked.
      monitorTypeSurfaces: "exclude",
      // Let the user move the capture to another tab mid-call without restarting.
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions);
    const tracks = display.getAudioTracks();
    if (tracks.length) tabAudio = new MediaStream(tracks);
  }

  if (opts.mic) {
    // With a second source for the interviewer, keep the processing on — it stops their
    // voice bleeding into your channel and being logged twice.
    const clean = !opts.micHearsRoom;
    try {
      micAudio = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: clean,
          noiseSuppression: clean,
          autoGainControl: clean,
        },
      });
    } catch {
      micAudio = null;
    }
  }

  // In device mode `tabAudio` is its own getUserMedia stream rather than a slice of the
  // display capture, so it has to be stopped explicitly. Captured now: `display` on the
  // bundle is mutable (a screenshot can assign one later) and must not decide this.
  const ownsTabAudio = !display && !!tabAudio;
  const bundle: CaptureBundle = {
    tabAudio,
    micAudio,
    display,
    stopAll() {
      // Read `display` off the bundle, not the closure — a screenshot may have replaced it.
      bundle.display?.getTracks().forEach((t) => t.stop());
      micAudio?.getTracks().forEach((t) => t.stop());
      if (ownsTabAudio) tabAudio?.getTracks().forEach((t) => t.stop());
    },
  };
  return bundle;
}

/** Grab a still frame from the shared display as base64 PNG (max long-edge px). */
export async function snapshotDisplay(
  display: MediaStream,
  maxEdge = 2000,
): Promise<{ base64: string; mediaType: "image/png" } | null> {
  const track = display.getVideoTracks()[0];
  if (!track) return null;
  const video = document.createElement("video");
  video.srcObject = new MediaStream([track]);
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await new Promise((r) => setTimeout(r, 120)); // let a frame land
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.pause();
  video.srcObject = null;
  const dataUrl = canvas.toDataURL("image/png");
  return { base64: dataUrl.split(",")[1], mediaType: "image/png" };
}

/**
 * Inline AudioWorklet RMS meter. It runs on the audio thread, which keeps ticking while the
 * tab is in the background — a requestAnimationFrame loop does not, and the transcript gate
 * depends on these samples, so a hidden tab used to look permanently silent.
 */
const METER_WORKLET = `
class RmsMeter extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.n = 0; this.last = currentTime; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) { for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i]; this.n += ch.length; }
    if (currentTime - this.last >= 0.05) {
      this.port.postMessage(this.n ? Math.sqrt(this.sum / this.n) : 0);
      this.sum = 0; this.n = 0; this.last = currentTime;
    }
    return true;
  }
}
registerProcessor("rms-meter", RmsMeter);
`;

/** RMS meter for a stream; returns a stop function. Reports ~20×/s, background tabs included. */
export function attachLevelMeter(stream: MediaStream, onLevel: (v: number) => void): () => void {
  const ctx = new AudioContext();
  let stopped = false;
  let src: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;

  (async () => {
    try {
      const url = URL.createObjectURL(new Blob([METER_WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (stopped) return;
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, "rms-meter", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e: MessageEvent<number>) => { if (!stopped) onLevel(Math.min(1, e.data * 3)); };
      // Silent sink: a worklet that reaches the destination is pulled by the audio thread even
      // when nothing is rendered on screen. The gain is 0, so nothing is played back.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      src.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      /* the meter is optional — never let it break capture */
    }
  })();

  return () => {
    stopped = true;
    try { node?.port.close(); node?.disconnect(); src?.disconnect(); } catch { /* ignore */ }
    ctx.close().catch(() => {});
  };
}
