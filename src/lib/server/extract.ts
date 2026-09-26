import { PDFParse } from "pdf-parse";

/** Turn an uploaded file into plain text. Supports PDF, TXT, MD, and anything text-like. */
export async function extractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const parser = new PDFParse({ data: buf });
    try {
      const res = await parser.getText();
      return res.text.trim();
    } finally {
      await parser.destroy();
    }
  }
  if (name.endsWith(".docx")) {
    // Minimal DOCX: pull text out of word/document.xml without a dependency.
    const text = await docxToText(buf);
    if (text) return text;
  }
  return buf.toString("utf8").trim();
}

async function docxToText(buf: Buffer): Promise<string> {
  try {
    const { inflateRawSync } = await import("node:zlib");
    // Walk the ZIP central directory for word/document.xml.
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return "";
    const cdOffset = buf.readUInt32LE(eocd + 16);
    const cdCount = buf.readUInt16LE(eocd + 10);
    let p = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOffset = buf.readUInt32LE(p + 42);
      const fname = buf.toString("utf8", p + 46, p + 46 + nameLen);
      if (fname === "word/document.xml") {
        const lnameLen = buf.readUInt16LE(localOffset + 26);
        const lextraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + lnameLen + lextraLen;
        const data = buf.subarray(dataStart, dataStart + compSize);
        const xml = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
        return xml
          .replace(/<\/w:p>/g, "\n")
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .trim();
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
  } catch {
    /* fall through */
  }
  return "";
}
