import os from "node:os";

/**
 * LAN addresses this dev server can be reached on, so the copilot can be read on a phone
 * instead of on the screen you are sharing. Nothing a screen share can capture is involved.
 *
 * `next dev` binds to localhost only; the URLs below work once it is started with
 * `npm run dev:lan` (adds `-H 0.0.0.0`).
 */
export async function GET(req: Request) {
  const port = new URL(req.url).port || "3000";
  const ips: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Skip loopback and link-local; keep ordinary private LAN ranges.
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue;
      ips.push(a.address);
    }
  }
  // 192.168.x is the usual home/office range — offer it first.
  ips.sort((a, b) => Number(b.startsWith("192.168.")) - Number(a.startsWith("192.168.")));
  return Response.json({
    port,
    ips,
    urls: ips.map((ip) => `http://${ip}:${port}`),
    boundToLan: process.env.HOSTNAME === "0.0.0.0" || process.env.PARAK_LAN === "1",
  });
}
