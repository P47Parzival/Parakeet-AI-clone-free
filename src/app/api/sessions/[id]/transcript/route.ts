import { addTranscriptLine, getSession, relabelTranscriptLines } from "@/lib/server/db";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSession(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const speaker = body.speaker === "me" ? "me" : "them";
  const text = String(body.text || "").trim();
  if (!text) return Response.json({ ok: true });
  const line = addTranscriptLine(id, speaker, text, Number(body.ts) || Date.now());
  return Response.json({ line });
}

/** Bulk speaker relabel — used when the diarized me/them mapping turned out flipped. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSession(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const them = Array.isArray(body.them) ? body.them.map(String) : [];
  const me = Array.isArray(body.me) ? body.me.map(String) : [];
  relabelTranscriptLines(id, them, "them");
  relabelTranscriptLines(id, me, "me");
  return Response.json({ ok: true });
}
