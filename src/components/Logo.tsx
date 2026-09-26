export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id="pk-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffcf6b" />
          <stop offset="1" stopColor="#ff7a3d" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="#12151d" stroke="rgba(236,233,225,0.14)" />
      {/* parakeet-ish beak + waveform */}
      <path d="M18 40c0-9 6-16 15-16 6 0 9 3 13 3l-6 6c-1 5-5 9-11 9-4 0-8-1-11-2z" fill="url(#pk-g)" />
      <circle cx="30" cy="30" r="2" fill="#12151d" />
      <path d="M14 46h4M20 46h3M25 46h6M33 46h4M39 46h9" stroke="#f4b23a" strokeWidth="2.4" strokeLinecap="round" opacity=".9" />
    </svg>
  );
}
