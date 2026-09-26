import {
  deleteSession, getResume, getSession, listAnswers, listTranscript, updateSession,
} from "@/lib/server/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "Not found" }, { status: 404 });
  const resume = session.resume_id ? getResume(session.resume_id) : undefined;
  return Response.json({
    session,
    resume: resume ? { id: resume.id, name: resume.name } : null,
    transcript: listTranscript(id),
    answers: listAnswers(id),
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!getSession(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const k of ["title", "extra_context", "job_description"]) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  updateSession(id, patch);
  return Response.json({ session: getSession(id) });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteSession(id);
  return Response.json({ ok: true });
}
