"use client";

/** POST JSON and consume our SSE format: {t}, {done,text}, {error}. Returns an abort function. */
export function streamJson(
  url: string,
  body: unknown,
  handlers: {
    onDelta: (t: string) => void;
    onDone: (full: string) => void;
    onError: (msg: string) => void;
  },
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j.error) msg = j.error;
        } catch {
          /* ignore */
        }
        handlers.onError(msg);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let full = "";
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        const chunks = buf.split("\n\n");
        buf = chunks.pop() ?? "";
        for (const c of chunks) {
          const line = c.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const j = JSON.parse(line.slice(6));
          if (j.t) {
            full += j.t;
            handlers.onDelta(j.t);
          } else if (j.done) {
            done = true;
            handlers.onDone(j.text ?? full);
          } else if (j.error) {
            done = true;
            handlers.onError(j.error);
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") handlers.onError((e as Error).message);
    }
  })();
  return () => ctrl.abort();
}
