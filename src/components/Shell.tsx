"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";

const NAV = [
  { href: "/", label: "Sessions", icon: "◎" },
  { href: "/library", label: "Library", icon: "▤" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const inSession = path.startsWith("/session/");
  return (
    <div className="min-h-screen flex">
      <aside
        className="hidden md:flex flex-col items-center gap-2 w-[68px] shrink-0 border-r border-line py-4 sticky top-0 h-screen"
        style={{ background: "rgba(10,12,16,0.7)", backdropFilter: "blur(10px)" }}
      >
        <Link href="/" className="mb-4" aria-label="Parak home">
          <Logo size={34} />
        </Link>
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" || inSession : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              title={n.label}
              className="w-11 h-11 rounded-xl flex items-center justify-center text-lg transition-colors"
              style={{
                color: active ? "var(--amber)" : "var(--muted)",
                background: active ? "rgba(244,178,58,0.1)" : "transparent",
                border: active ? "1px solid rgba(244,178,58,0.3)" : "1px solid transparent",
              }}
            >
              <span aria-hidden>{n.icon}</span>
              <span className="sr-only">{n.label}</span>
            </Link>
          );
        })}
        <div className="mt-auto mono text-[10px] text-dim tracking-widest [writing-mode:vertical-rl] rotate-180 select-none">
          PARAK · v0.1
        </div>
      </aside>
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
