import { z } from "zod";
import { getSession, listAnswers, listTranscript, updateSession } from "@/lib/server/db";
import { errorJson, structured } from "@/lib/server/llm";
import { NOTES_INSTRUCTIONS } from "@/lib/server/prompts";
import type { SessionNotes } from "@/lib/types";

export const maxDuration = 180;

const NotesSchema = z.object({
  summary: z.string().describe("3–5 sentence summary of how the interview went, in second person ('You...')."),
  questions: z.array(z.object({
    question: z.string(),
    how_it_went: z.string().describe("One or two sentences on how the candidate handled it."),
  })),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()).describe("Concrete, actionable things to do better next time."),
  action_items: z.array(z.string()).describe("Follow-ups: things promised, people to email, topics to study."),
  follow_up_email: z.string().describe("A short thank-you / follow-up email draft to the interviewer."),
});

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });

  updateSession(id, { status: "ended", ended_at: session.ended_at ?? Date.now() });

  const transcript = listTranscript(id);
  const answers = listAnswers(id);
  if (transcript.length < 3 && answers.length === 0) {
    const notes: SessionNotes = {
      summary: "Not enough transcript was captured to write notes.",
      questions: [], strengths: [], improvements: [], action_items: [], follow_up_email: "",
    };
    updateSession(id, { notes_json: JSON.stringify(notes) });
    return Response.json({ notes, session: getSession(id) });
  }

  try {
    const transcriptText = transcript
      .map((l) => `[${new Date(l.ts).toISOString().slice(11, 19)}] ${l.speaker === "them" ? "Interviewer" : "Me"}: ${l.text}`)
      .join("\n");
    const answersText = answers
      .map((a) => `Q: ${a.question}\nSuggested: ${a.answer.slice(0, 600)}`)
      .join("\n\n");

    const notes = await structured<SessionNotes>(
      {
        system: NOTES_INSTRUCTIONS,
        text: `Interview: ${session.title}\n\n<transcript>\n${transcriptText || "(none)"}\n</transcript>\n\n<copilot_suggestions>\n${answersText || "(none)"}\n</copilot_suggestions>\n\nWrite the notes.`,
        maxTokens: 6000,
        effort: "medium",
        sessionId: id,
      },
      NotesSchema,
    );
    updateSession(id, { notes_json: JSON.stringify(notes) });
    return Response.json({ notes, session: getSession(id) });
  } catch (err) {
    return errorJson(err);
  }
}
