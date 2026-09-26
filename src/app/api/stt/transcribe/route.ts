import OpenAI, { toFile } from "openai";
import { getSettings } from "@/lib/server/db";

/**
 * Chunked fallback for OpenAI STT: multipart { file, language? } → { text }.
 * Used when the Realtime WebSocket can't be established (older accounts, blocked WS, etc.).
 */
export async function POST(req: Request) {
  const s = getSettings();
  if (!s.openaiKey) return Response.json({ error: "No OpenAI API key" }, { status: 400 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1000) return Response.json({ text: "" });
  const language = String(form.get("language") || "");
  try {
    const client = new OpenAI({ apiKey: s.openaiKey });
    const res = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: await toFile(Buffer.from(await file.arrayBuffer()), file.name || "chunk.webm", { type: file.type || "audio/webm" }),
      ...(language && language !== "auto" ? { language } : {}),
      response_format: "json",
    });
    return Response.json({ text: (res as { text: string }).text ?? "" });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
