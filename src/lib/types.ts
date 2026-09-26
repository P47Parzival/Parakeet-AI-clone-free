export type Speaker = "them" | "me";

export type LlmProvider = "anthropic" | "openai";
export type SttProvider = "deepgram" | "openai" | "webspeech";

export interface Settings {
  provider: LlmProvider;
  anthropicKey: string;
  openaiKey: string;
  deepgramKey: string;
  /** Anthropic model id */
  model: string;
  /** OpenAI-compatible endpoint base URL (OpenAI, Groq, Gemini, NVIDIA, OpenRouter, Ollama, HF…) */
  openaiBaseUrl: string;
  /** Model id for the OpenAI-compatible endpoint */
  openaiModel: string;
  language: string;
  autoAnswer: "questions" | "always" | "off";
  answerStyle: "concise" | "detailed";
  sttProvider: SttProvider;
  /**
   * mic    = just the microphone (put the call on speaker);
   * tab    = share the meeting tab's audio + mic (starts a screen share — can fight with a share you give the interviewer);
   * device = interviewer audio from a loopback input device (BlackHole/VB-Cable) + mic. No screen share at all.
   */
  captureMode: "mic" | "tab" | "device";
  /** Input device id used as the interviewer channel in `device` capture mode. */
  themDeviceId: string;
  /** Silence (ms) required after the last speech before an auto-answer fires. */
  answerDelayMs: string;
  /** "on" = never auto-answer while your own microphone is picking up speech. */
  pauseWhileSpeaking: "on" | "off";
  /** Monthly spend ceiling in USD the usage meter reports against. "0" hides the percentages. */
  budgetUsd: string;
  /**
   * Live answers trade depth for latency. "fast" answers on Claude Sonnet 5 (~0.6s to the
   * first word); "best" uses whatever `model` is set to (Opus 5 is ~2.5s). Screenshots and
   * post-interview notes always use `model` — a few seconds don't matter there.
   */
  answerSpeed: "fast" | "best";
  /**
   * Hold this key (~⅓s, on its own) to answer immediately — grabs everything the
   * interviewer said since the last answer, including text still being transcribed,
   * without waiting for the silence delay. Works in the main window and the pop-out.
   */
  answerHotkey: "ctrl" | "alt" | "off";
}

/** One provider's line in the usage meter. */
export interface ProviderMeter {
  provider: string;
  label: string;
  role: "answers" | "transcription";
  model: string;
  /** account = a real balance from the vendor; budget = metered spend vs. your cap; free = nothing to bill. */
  source: "account" | "budget" | "free";
  spentUsd: number;
  budgetUsd?: number;
  balanceUsd?: number;
  percentLeft: number | null;
  tokens?: number;
  minutes?: number;
  sessionUsd: number;
  note?: string;
}

export interface UsageReport {
  monthStart: number;
  budgetUsd: number;
  totalSpentUsd: number;
  sessionSpentUsd: number;
  meters: ProviderMeter[];
}

export interface Resume {
  id: string;
  name: string;
  content: string;
  created_at: number;
}

export interface Doc {
  id: string;
  name: string;
  content: string;
  created_at: number;
}

export interface Session {
  id: string;
  title: string;
  language: string;
  resume_id: string | null;
  job_description: string;
  extra_context: string;
  status: "active" | "ended";
  created_at: number;
  ended_at: number | null;
  notes_json: string | null;
}

export interface SessionSummary extends Session {
  question_count: number;
  line_count: number;
}

export interface TranscriptLine {
  id: string;
  session_id: string;
  speaker: Speaker;
  text: string;
  ts: number;
  /** Client-only: diarized voice id this line came from (not persisted). */
  dg?: number;
}

export interface Answer {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  kind: "auto" | "manual" | "vision";
  created_at: number;
}

export interface SessionNotes {
  summary: string;
  questions: { question: string; how_it_went: string }[];
  strengths: string[];
  improvements: string[];
  action_items: string[];
  follow_up_email: string;
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: "auto", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "hi", label: "Hindi" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "ru", label: "Russian" },
];

export const MODELS: { id: string; label: string; note: string }[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", note: "Best answers (default)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Fast + strong" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Cheapest, fastest" },
];

export interface EndpointPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Recommended default model for live answers. */
  model: string;
  /** Other models worth trying (first = default). */
  models: string[];
  keyUrl: string;
  note: string;
  /** Vision (screenshot solving) works with the default model. */
  vision: boolean;
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    id: "groq", label: "Groq (free tier)", baseUrl: "https://api.groq.com/openai/v1",
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    models: ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile", "meta-llama/llama-4-maverick-17b-128e-instruct", "openai/gpt-oss-120b"],
    keyUrl: "https://console.groq.com/keys", note: "Fastest — ideal for live answers. Free, no card.", vision: true,
  },
  {
    id: "gemini", label: "Google Gemini (free tier)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    keyUrl: "https://aistudio.google.com/apikey", note: "Best quality of the free options; vision works well.", vision: true,
  },
  {
    id: "nvidia", label: "NVIDIA NIM (free credits)", baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
    models: ["meta/llama-3.3-70b-instruct", "nvidia/llama-3.1-nemotron-70b-instruct", "meta/llama-3.2-90b-vision-instruct", "qwen/qwen2.5-coder-32b-instruct"],
    keyUrl: "https://build.nvidia.com/", note: "1000 free API credits on signup.", vision: false,
  },
  {
    id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct:free",
    models: ["meta-llama/llama-3.3-70b-instruct:free", "google/gemini-2.0-flash-exp:free", "qwen/qwen2.5-vl-72b-instruct:free"],
    keyUrl: "https://openrouter.ai/keys", note: "Many models; ':free' ones cost nothing (rate-limited).", vision: false,
  },
  {
    id: "huggingface", label: "Hugging Face", baseUrl: "https://router.huggingface.co/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct",
    models: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-VL-72B-Instruct"],
    keyUrl: "https://huggingface.co/settings/tokens", note: "Small free monthly credits; slower.", vision: false,
  },
  {
    id: "ollama", label: "Ollama (local, offline)", baseUrl: "http://localhost:11434/v1",
    model: "llama3.1:8b",
    models: ["llama3.1:8b", "qwen2.5:14b", "qwen2.5vl:7b", "gemma3:12b"],
    keyUrl: "https://ollama.com/download", note: "100% free, runs on your Mac. `ollama pull llama3.1:8b`. Key can be anything.", vision: false,
  },
  {
    id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-4o"],
    keyUrl: "https://platform.openai.com/api-keys", note: "Paid.", vision: true,
  },
];
