import { addAnswer, getResume, getSession, getSettings, listDocs, listTranscript } from "@/lib/server/db";
import { errorJson, sseResponse, streamText } from "@/lib/server/llm";
import { buildAnswerUser, buildCopilotSystem, formatRecentTranscript } from "@/lib/server/prompts";

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionId = String(body.sessionId || "");
    const question = String(body.question || "").trim();
    const kind = body.kind === "manual" ? "manual" : "auto";
    if (!question) return Response.json({ error: "Empty question" }, { status: 400 });
    const session = getSession(sessionId);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });

    const settings = getSettings();
    const resume = session.resume_id ? getResume(session.resume_id) : undefined;
    const system = buildCopilotSystem({ session, resume, docs: listDocs(), settings });
    const recent = formatRecentTranscript(listTranscript(sessionId));

    const stream = streamText({
      system,
      text: buildAnswerUser(question, recent),
      sessionId,
      maxTokens: settings.answerStyle === "detailed" ? 3000 : 1600,
      effort: "low",
      speed: "fast",
    });
    return sseResponse(stream, (full) => {
      if (full.trim()) addAnswer(sessionId, question, full, kind);
    });
  } catch (err) {
    return errorJson(err);
  }
}
