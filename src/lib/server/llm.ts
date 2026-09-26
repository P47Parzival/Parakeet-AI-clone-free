import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { getSettings, recordUsage } from "./db";
import { tokenCost } from "./pricing";
import type { Settings } from "../types";

/** Provider-neutral request shape used by the answer / vision / notes routes. */
export interface LlmRequest {
  system: string;
  /** Text prompt for the user turn. */
  text: string;
  /** Optional image (base64, no data: prefix) placed before the text. */
  image?: { base64: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" };
  maxTokens: number;
  /** Relative thinking budget; mapped per provider. */
  effort: "low" | "medium";
  /** Attributes the metered spend to a session. */
  sessionId?: string;
  /**
   * Live answers are latency-critical — the candidate is mid-sentence. `speed: "fast"`
   * routes them to a lower-latency model (measured: ~0.6s to the first word vs ~2.5s on
   * Opus 5). Screenshots and notes leave this unset and use the configured model.
   */
  speed?: "fast";
}

/** Book one request's token spend so the usage meter can show what's left. */
function meter(
  provider: "anthropic" | "openai",
  model: string,
  sessionId: string | undefined,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
) {
  if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite) return;
  try {
    recordUsage({
      provider,
      service: "llm",
      model,
      session_id: sessionId ?? null,
      input: u.input,
      output: u.output,
      cache_read: u.cacheRead,
      cache_write: u.cacheWrite,
      cost_usd: tokenCost(provider, model, u),
    });
  } catch {
    // Metering must never break an answer mid-interview.
  }
}

export interface TextStream {
  /** Async iterator over text deltas. */
  deltas: AsyncIterable<string>;
  /** Resolves after the stream ends. `refused` = provider declined with no text. */
  done: () => Promise<{ refused: boolean }>;
}

export class MissingKeyError extends Error {
  constructor(provider: Settings["provider"]) {
    super(
      provider === "openai"
        ? "No OpenAI API key. Add OPENAI_API_KEY to .env.local or paste it in Settings."
        : "No Anthropic API key. Add ANTHROPIC_API_KEY to .env.local or paste it in Settings.",
    );
  }
}

export function activeProvider() {
  const s = getSettings();
  return { provider: s.provider, settings: s };
}

// ---------------------------------------------------------------- Anthropic
/** Low-latency stand-in used when a request asks for speed and the user opted into it. */
export const FAST_MODEL = "claude-sonnet-5";

function anthropicClient(s: Settings, req?: LlmRequest) {
  if (!s.anthropicKey) throw new MissingKeyError("anthropic");
  const configured = s.model || "claude-opus-5";
  const wantsFast = req?.speed === "fast" && s.answerSpeed !== "best";
  // Never "upgrade" — if the configured model is already quicker than the fast model, keep it.
  const model = wantsFast && configured.startsWith("claude-opus") ? FAST_MODEL : configured;
  return { client: new Anthropic({ apiKey: s.anthropicKey }), model };
}

/** Model-family-aware params: thinking/effort/fallbacks only where supported. */
function anthropicFamily(model: string, effort: "low" | "medium") {
  const isOpus5 = model.startsWith("claude-opus-5") || model.startsWith("claude-fable-5");
  const supportsEffort = !model.startsWith("claude-haiku");
  return {
    ...(supportsEffort ? { output_config: { effort } } : {}),
    // Server-side refusal fallback: routes a classifier decline to a fallback model
    // instead of returning an empty answer mid-interview. Opus 5 / Fable 5 only — and the
    // key must be omitted entirely elsewhere, since an empty `betas` array still sends an
    // empty anthropic-beta header, which the API rejects with a 400.
    ...(isOpus5
      ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const }
      : {}),
  };
}

function anthropicStream(s: Settings, req: LlmRequest): TextStream {
  const { client, model } = anthropicClient(s, req);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.image) content.push({ type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.base64 } });
  content.push({ type: "text", text: req.text });
  const stream = client.beta.messages.stream({
    model,
    max_tokens: req.maxTokens,
    ...anthropicFamily(model, req.effort),
    // Résumé + docs are the stable prefix → cache them; the question varies per call.
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });
  let sawText = false;
  const deltas = (async function* () {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        sawText = sawText || ev.delta.text.trim().length > 0;
        yield ev.delta.text;
      }
    }
  })();
  return {
    deltas,
    done: async () => {
      const final = await stream.finalMessage();
      meter("anthropic", model, req.sessionId, {
        input: final.usage.input_tokens ?? 0,
        output: final.usage.output_tokens ?? 0,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
        cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
      });
      return { refused: final.stop_reason === "refusal" && !sawText };
    },
  };
}

async function anthropicStructured<T>(s: Settings, req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
  const { client, model } = anthropicClient(s, req);
  const fam = anthropicFamily(model, req.effort);
  const msg = await client.beta.messages.parse({
    model,
    max_tokens: req.maxTokens,
    ...fam,
    system: req.system,
    messages: [{ role: "user", content: req.text }],
    output_config: { ...(fam.output_config ?? {}), format: betaZodOutputFormat(schema) },
  });
  meter("anthropic", model, req.sessionId, {
    input: msg.usage.input_tokens ?? 0,
    output: msg.usage.output_tokens ?? 0,
    cacheRead: msg.usage.cache_read_input_tokens ?? 0,
    cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
  });
  const out = msg.parsed_output as T | null;
  if (!out) throw new Error("Model returned no structured output");
  return out;
}

// ------------------------------------------------- OpenAI-compatible (OpenAI, Groq, Gemini, NVIDIA, OpenRouter, Ollama, HF…)
function openaiClient(s: Settings) {
  const baseURL = (s.openaiBaseUrl || "https://api.openai.com/v1").trim();
  const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);
  if (!s.openaiKey && !isLocal) throw new MissingKeyError("openai");
  return {
    client: new OpenAI({ apiKey: s.openaiKey || "ollama", baseURL, defaultHeaders: baseURL.includes("openrouter") ? { "HTTP-Referer": "http://localhost", "X-Title": "Parak" } : undefined }),
    model: s.openaiModel || "gpt-4.1",
    isOpenAI: baseURL.includes("api.openai.com"),
    // `stream_options` is an OpenAI extension; several compat servers 400 on it.
    supportsUsageInStream: /api\.openai\.com|api\.groq\.com|openrouter\.ai/.test(baseURL),
  };
}

/** OpenAI reasoning-family models accept `reasoning_effort` and want `developer` role. */
function isOpenAIReasoningModel(model: string) {
  return /^(gpt-5|o[134])/.test(model);
}

function compatParams(isOpenAI: boolean, model: string, maxTokens: number, effort: "low" | "medium") {
  const reasoning = isOpenAI && isOpenAIReasoningModel(model);
  return {
    systemRole: (reasoning ? "developer" : "system") as "developer" | "system",
    // OpenAI deprecates max_tokens in favour of max_completion_tokens; most compat servers only know max_tokens.
    ...(isOpenAI ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(reasoning ? { reasoning_effort: (effort === "low" ? "minimal" : "low") as "minimal" | "low" } : {}),
  };
}

function openaiStream(s: Settings, req: LlmRequest): TextStream {
  const { client, model, isOpenAI, supportsUsageInStream } = openaiClient(s);
  const { systemRole, ...params } = compatParams(isOpenAI, model, req.maxTokens, req.effort);
  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [];
  if (req.image) userContent.push({ type: "image_url", image_url: { url: `data:${req.image.mediaType};base64,${req.image.base64}`, detail: "high" } });
  userContent.push({ type: "text", text: req.text });
  const streamP = client.chat.completions.create({
    model,
    stream: true,
    // Usage only arrives in a final chunk when explicitly requested — and only where supported.
    ...(supportsUsageInStream ? { stream_options: { include_usage: true } } : {}),
    messages: [
      { role: systemRole, content: req.system },
      { role: "user", content: userContent },
    ],
    ...params,
  });
  let sawText = false;
  let finish: string | null | undefined;
  let used: OpenAI.CompletionUsage | undefined;
  const deltas = (async function* () {
    const stream = await streamP;
    for await (const chunk of stream) {
      if (chunk.usage) used = chunk.usage;
      const c = chunk.choices?.[0];
      const t = c?.delta?.content;
      if (c?.finish_reason) finish = c.finish_reason;
      if (t) {
        sawText = sawText || t.trim().length > 0;
        yield t;
      }
    }
  })();
  return {
    deltas,
    done: async () => {
      if (used) {
        const cached = used.prompt_tokens_details?.cached_tokens ?? 0;
        meter("openai", model, req.sessionId, {
          input: Math.max(0, (used.prompt_tokens ?? 0) - cached),
          output: used.completion_tokens ?? 0,
          cacheRead: cached,
          cacheWrite: 0,
        });
      }
      return { refused: finish === "content_filter" && !sawText };
    },
  };
}

function meterCompletion(model: string, sessionId: string | undefined, usage?: OpenAI.CompletionUsage) {
  if (!usage) return;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  meter("openai", model, sessionId, {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    output: usage.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
  });
}

async function openaiStructured<T>(s: Settings, req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
  const { client, model, isOpenAI } = openaiClient(s);
  const { systemRole, ...params } = compatParams(isOpenAI, model, req.maxTokens, req.effort);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: systemRole, content: req.system },
    { role: "user", content: req.text },
  ];
  // 1) Strict JSON schema (OpenAI, Groq, Gemini support this).
  try {
    const completion = await client.chat.completions.parse({
      model,
      messages,
      ...params,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: zodResponseFormat(schema as any, "output"),
    });
    meterCompletion(model, req.sessionId, completion.usage);
    const out = completion.choices[0]?.message.parsed as T | null | undefined;
    if (out) return out;
  } catch (e) {
    if (isOpenAI) throw e; // OpenAI proper supports this; a failure there is real.
  }
  // 2) Fallback for endpoints without json_schema: ask for JSON, validate with zod.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = zodResponseFormat(schema as any, "output").json_schema.schema;
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: systemRole, content: `${req.system}\n\nRespond with ONLY a JSON object matching this JSON Schema (no markdown fences):\n${JSON.stringify(jsonSchema)}` },
      { role: "user", content: req.text },
    ],
    ...params,
    response_format: { type: "json_object" },
  });
  meterCompletion(model, req.sessionId, completion.usage);
  const raw = completion.choices[0]?.message.content ?? "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return schema.parse(JSON.parse(cleaned));
}

// ---------------------------------------------------------------- public
export function streamText(req: LlmRequest): TextStream {
  const s = getSettings();
  return s.provider === "openai" ? openaiStream(s, req) : anthropicStream(s, req);
}

export function structured<T>(req: LlmRequest, schema: z.ZodType<T>): Promise<T> {
  const s = getSettings();
  return s.provider === "openai" ? openaiStructured(s, req, schema) : anthropicStructured(s, req, schema);
}

/**
 * Wrap a TextStream as a Server-Sent-Events Response.
 * `data: {"t": "..."}` per delta, `data: {"done": true, "text": full}` at the end, `data: {"error": "..."}` on failure.
 */
export function sseResponse(ts: TextStream, onDone?: (fullText: string) => void | Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let full = "";
      try {
        for await (const t of ts.deltas) {
          full += t;
          send({ t });
        }
        const { refused } = await ts.done();
        if (refused && !full.trim()) {
          send({ error: "The model declined this request." });
        } else {
          if (onDone) await onDone(full);
          send({ done: true, text: full });
        }
      } catch (err) {
        send({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function errorJson(err: unknown, status?: number) {
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: msg }, { status: status ?? (err instanceof MissingKeyError ? 400 : 500) });
}
