"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SIZE_KEY = "parak.popout.size";
const DEFAULT_SIZE = { width: 460, height: 600 };

type Size = { width: number; height: number };
/** "pip" = Chrome Document Picture-in-Picture — the only web window that floats above other apps. */
export type PopOutKind = "pip" | "popup";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

function readSize(): Size {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return DEFAULT_SIZE;
    const s = JSON.parse(raw) as Partial<Size>;
    if (!s?.width || !s?.height) return DEFAULT_SIZE;
    return { width: clamp(s.width, 280, 1400), height: clamp(s.height, 120, 1400) };
  } catch {
    return DEFAULT_SIZE;
  }
}

function saveSize(width: number, height: number) {
  try { localStorage.setItem(SIZE_KEY, JSON.stringify({ width: Math.round(width), height: Math.round(height) })); } catch { /* ignore */ }
}

/** Clone the app's stylesheets into the overlay document so it looks like the app. */
function copyStyles(doc: Document) {
  for (const ss of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(ss.cssRules).map((r) => r.cssText).join("\n");
      const style = doc.createElement("style");
      style.textContent = css;
      doc.head.appendChild(style);
    } catch {
      if (ss.href) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = ss.href;
        doc.head.appendChild(link);
      }
    }
  }
}

/**
 * Renders `children` in a floating overlay window.
 *
 * Pinned (`kind: "pip"`) uses Chrome Document Picture-in-Picture: the window stays above
 * every other app on whatever screen you drag it to, and never appears in a tab or window
 * share. Unpinned (`kind: "popup"`) is an ordinary popup — it can go behind other windows,
 * but scripts may move it, so the overlay's own grip can drag it.
 *
 * The window remembers its size, keeps its styles in sync with the app (dev-time CSS
 * injection included) and forwards ⌘/Ctrl shortcuts back to the main tab.
 */
export function usePopOut() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [kind, setKind] = useState<PopOutKind | null>(null);
  const winRef = useRef<Window | null>(null);
  const kindRef = useRef<PopOutKind | null>(null);
  const cleanups = useRef<(() => void)[]>([]);

  const teardown = useCallback(() => {
    cleanups.current.forEach((f) => { try { f(); } catch { /* ignore */ } });
    cleanups.current = [];
  }, []);

  const destroy = useCallback(() => {
    teardown();
    winRef.current?.close();
    winRef.current = null;
    kindRef.current = null;
    setKind(null);
    setContainer(null);
  }, [teardown]);

  const close = destroy;

  const focus = useCallback(() => {
    const win = winRef.current;
    if (win && !win.closed) win.focus();
  }, []);

  /** Resize the floating window — used by the overlay's bar / compact / full modes. */
  const resize = useCallback((width: number, height: number) => {
    const win = winRef.current;
    saveSize(width, height);
    if (!win || win.closed) return;
    try { win.resizeTo(clamp(width, 280, 1400), clamp(height, 120, 1400)); } catch { /* PiP may refuse; size is still remembered */ }
  }, []);

  /** Move the window by a screen-pixel delta. Only popups may be moved by script. */
  const moveBy = useCallback((dx: number, dy: number) => {
    const win = winRef.current;
    if (!win || win.closed) return false;
    try {
      const before = win.screenX;
      win.moveBy(Math.round(dx), Math.round(dy));
      return dx === 0 || win.screenX !== before;
    } catch {
      return false;
    }
  }, []);

  const open = useCallback(async (opts?: { width?: number; height?: number; kind?: PopOutKind }) => {
    const want = { ...readSize(), ...opts };
    const supported = !!window.documentPictureInPicture;
    const wantKind: PopOutKind = opts?.kind ?? (supported ? "pip" : "popup");
    if (wantKind === "pip" && !supported) {
      throw new Error("Pinning needs Chrome or Edge 116+ — this browser has no Picture-in-Picture window, so the overlay can only be a normal window.");
    }
    if (winRef.current && !winRef.current.closed && kindRef.current === wantKind) { winRef.current.focus(); return; }
    // Both window kinds may only be created while this document holds a user activation —
    // a click inside the overlay window activates that window, not this one.
    if (!(navigator.userActivation?.isActive ?? true)) {
      throw new Error("Browsers only open a floating window straight from a click in the Parak tab — use the 📌 button in Parak's top bar.");
    }

    // Build the new window before dropping the old one, so a refused request leaves the
    // current overlay untouched.
    const old = winRef.current;
    let win: Window | null = null;
    if (wantKind === "pip") {
      win = await window.documentPictureInPicture!.requestWindow({ width: want.width, height: want.height });
    } else {
      win = window.open("", "parak-overlay", `popup=yes,width=${want.width},height=${want.height},top=80,left=80`);
      if (!win) throw new Error("Popup blocked — allow popups for this site.");
    }
    const doc = win.document;
    doc.title = "Parak · copilot";
    doc.documentElement.className = document.documentElement.className;
    copyStyles(doc);
    const style = doc.createElement("style");
    style.textContent = `html,body{height:100%;margin:0;overflow:hidden} body::after{display:none}`;
    doc.head.appendChild(style);
    const root = doc.createElement("div");
    root.id = "parak-overlay-root";
    root.style.height = "100%";
    doc.body.appendChild(root);

    // Styles injected after the window opened (Next's dev-time CSS, lazy chunks) must follow it over.
    const headObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of Array.from(m.addedNodes)) {
          if (n instanceof HTMLStyleElement || (n instanceof HTMLLinkElement && n.rel === "stylesheet")) {
            doc.head.appendChild(n.cloneNode(true));
          }
        }
      }
    });
    headObserver.observe(document.head, { childList: true });
    const themeObserver = new MutationObserver(() => { doc.documentElement.className = document.documentElement.className; });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // Shortcuts fire against the main tab, so replay them there when the overlay has focus.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
      }));
    };
    doc.addEventListener("keydown", onKey);

    const onResize = () => saveSize(win!.innerWidth, win!.innerHeight);
    win.addEventListener("resize", onResize);
    win.addEventListener("pagehide", () => { teardown(); winRef.current = null; kindRef.current = null; setKind(null); setContainer(null); });

    cleanups.current = [
      () => headObserver.disconnect(),
      () => themeObserver.disconnect(),
      () => doc.removeEventListener("keydown", onKey),
      () => win!.removeEventListener("resize", onResize),
    ];
    if (old && !old.closed) { teardown(); old.close(); }
    winRef.current = win;
    kindRef.current = wantKind;
    setKind(wantKind);
    setContainer(root);
  }, [teardown]);

  /** Pin = always-on-top PiP window. Unpin = ordinary popup you can push behind things. */
  const setPinned = useCallback((on: boolean) => open({ kind: on ? "pip" : "popup" }), [open]);

  useEffect(() => () => { winRef.current?.close(); }, []);

  const Portal = useCallback(
    ({ children }: { children: React.ReactNode }) => (container ? createPortal(children, container) : null),
    [container],
  );

  return {
    open, close, focus, resize, moveBy, setPinned,
    isOpen: !!container,
    kind,
    pinned: kind === "pip",
    /** Only script-opened popups may be dragged from inside the page. */
    canDrag: kind === "popup",
    Portal,
    supported: typeof window !== "undefined" && !!window.documentPictureInPicture,
  };
}
