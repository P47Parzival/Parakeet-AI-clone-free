"use client";

/**
 * Self-echo suppression.
 *
 * The copilot writes an answer, you read it out loud, the microphone hears it, the
 * transcriber labels it as the interviewer and the copilot answers its own answer.
 * These helpers spot that loop: a line that is mostly made of words the copilot just
 * wrote (or that you just said) is your own voice coming back, not a new question.
 */

const STOP = new Set([
  "a", "an", "the", "and", "or", "but", "so", "of", "to", "in", "on", "for", "with", "at", "by",
  "is", "are", "was", "were", "be", "been", "am", "it", "its", "this", "that", "these", "those",
  "i", "you", "we", "they", "he", "she", "my", "your", "our", "their", "me", "us", "them",
  "as", "if", "then", "than", "from", "not", "no", "do", "does", "did", "can", "could", "would",
  "will", "just", "about", "into", "over", "up", "out", "very", "really",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_#>\[\]()]/g, " ") // strip markdown so answer text compares like speech
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words only — stop words match everywhere and would make everything look like an echo. */
export function contentWords(text: string): string[] {
  return normalize(text).split(" ").filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Share of `line`'s content words that also appear in `source`.
 * 1 = every word of the line is in the source, 0 = nothing in common.
 */
export function overlapRatio(line: string, source: string): number {
  const words = contentWords(line);
  if (!words.length) return 0;
  const pool = new Set(contentWords(source));
  if (!pool.size) return 0;
  let hits = 0;
  for (const w of words) if (pool.has(w)) hits++;
  return hits / words.length;
}

/**
 * Two questions that mean the same thing, so we don't answer the same one twice.
 *
 * 0.75 tolerates the stray extra word a re-transcription adds ("…please", "…again")
 * while still letting a genuine follow-up through: "tell me about Kafka" vs "tell me
 * about Kafka partitioning" scores 0.67 and is correctly treated as a new question.
 */
export function nearlySame(a: string, b: string, threshold = 0.75): boolean {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.length || !wb.length) return false;
  const setB = new Set(wb);
  const hits = wa.filter((w) => setB.has(w)).length;
  const jaccard = hits / new Set([...wa, ...wb]).size;
  return jaccard >= threshold;
}

export interface EchoContext {
  /** Text of the answers the copilot recently produced (newest first is fine). */
  answers: string[];
  /** Lines already attributed to you. */
  mine: string[];
}

/**
 * Is this line you reading the copilot's answer back, or repeating yourself?
 * Short lines are ignored — "yes", "right", "okay" overlap with everything.
 */
export function isSelfEcho(line: string, ctx: EchoContext, threshold = 0.62): boolean {
  const words = contentWords(line);
  if (words.length < 4) return false;
  for (const a of ctx.answers) {
    if (a && overlapRatio(line, a) >= threshold) return true;
  }
  for (const m of ctx.mine) {
    if (m && overlapRatio(line, m) >= 0.85) return true;
  }
  return false;
}

export interface AnswerGate {
  /** Session is live. Anything scheduled after Pause must not fire. */
  live: boolean;
  /** Manual hold — you told the copilot to stay quiet. Absolute. */
  hold: boolean;
  /** An answer is already streaming. */
  streaming: boolean;
  /** Honour the "pause while you speak" setting. */
  guardSpeech: boolean;
  /** Milliseconds since a microphone last carried speech. */
  quietForMs: number;
  /** Silence required before answering. */
  delayMs: number;
  /** How long this answer has been waiting to fire. */
  waitedMs: number;
  /** Cap on the speech/streaming waits so noise can't stall answers forever. */
  stallCapMs?: number;
}

export type GateDecision = "fire" | "wait" | "drop";

/**
 * Should a queued auto-answer fire now?
 *
 * `drop` when the session is no longer live, `wait` while someone is still talking or a
 * previous answer is streaming, `fire` otherwise. A manual hold outranks the stall cap:
 * an explicit hold never times out.
 */
export function answerGate(g: AnswerGate): GateDecision {
  if (!g.live) return "drop";
  if (g.hold) return "wait";
  const stalled = g.waitedMs >= (g.stallCapMs ?? 20_000);
  if (stalled) return "fire";
  if (g.streaming) return "wait";
  if (g.guardSpeech && g.quietForMs < g.delayMs) return "wait";
  return "fire";
}
