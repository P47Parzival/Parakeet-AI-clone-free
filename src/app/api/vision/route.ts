import { addAnswer, getResume, getSession, getSettings, listDocs } from "@/lib/server/db";
import { errorJson, sseResponse, streamText, type LlmRequest } from "@/lib/server/llm";
import { buildCopilotSystem, VISION_INSTRUCTIONS } from "@/lib/server/prompts";

export const maxDuration = 180;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionId = String(body.sessionId || "");
    const image = String(body.image || ""); // base64, no data: prefix
    const mediaType = (body.mediaType || "image/png") as NonNullable<LlmRequest["image"]>["mediaType"];
    const hint = String(body.hint || "").trim();
    if (!image) return Response.json({ error: "No image" }, { status: 400 });
    const session = getSession(sessionId);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    const settings = getSettings();
    const resume = session.resume_id ? getResume(session.resume_id) : undefined;
    const system = buildCopilotSystem({ session, resume, docs: listDocs(), settings });

    const stream = streamText({
      system,
      image: { base64: image, mediaType },
      text: VISION_INSTRUCTIONS + (hint ? `\n\nCandidate's hint: ${hint}` : ""),
      maxTokens: 8000,
      sessionId,
      effort: "medium", // coding problems deserve more thought than a spoken answer
    });
    return sseResponse(stream, (full) => {
      if (full.trim()) addAnswer(sessionId, hint ? `[Screenshot] ${hint}` : "[Screenshot]", full, "vision");
    });
  } catch (err) {
    return errorJson(err);
  }
}
