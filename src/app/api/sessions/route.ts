import { createSession, getSettings, listSessions } from "@/lib/server/db";

export async function GET() {
  return Response.json({ sessions: listSessions() });
}

export async function POST(req: Request) {
  const body = await req.json();
  const settings = getSettings();
  const s = createSession({
    title: String(body.title || "Untitled interview").slice(0, 200),
    language: String(body.language || settings.language || "en"),
    resume_id: body.resume_id ? String(body.resume_id) : null,
    job_description: String(body.job_description || ""),
    extra_context: String(body.extra_context || ""),
  });
  return Response.json({ session: s });
}
