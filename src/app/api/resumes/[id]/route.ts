import { deleteResume } from "@/lib/server/db";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  deleteResume(id);
  return Response.json({ ok: true });
}
