import { createDoc, listDocs } from "@/lib/server/db";
import { extractText } from "@/lib/server/extract";

export async function GET() {
  return Response.json({ documents: listDocs() });
}

/** Accepts multipart (field "file", optional "name") or JSON { name, content }. */
export async function POST(req: Request) {
  const ct = req.headers.get("content-type") || "";
  let name = "";
  let content = "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "No file" }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return Response.json({ error: "File too large (15 MB max)" }, { status: 413 });
    name = String(form.get("name") || file.name);
    try {
      content = await extractText(file);
    } catch (e) {
      return Response.json({ error: "Could not read file: " + (e instanceof Error ? e.message : e) }, { status: 400 });
    }
  } else {
    const body = await req.json();
    name = String(body.name || "Untitled");
    content = String(body.content || "");
  }
  content = content.trim();
  if (!content) return Response.json({ error: "No text could be extracted." }, { status: 400 });
  const item = createDoc(name.slice(0, 120), content.slice(0, 200_000));
  return Response.json({ item });
}
