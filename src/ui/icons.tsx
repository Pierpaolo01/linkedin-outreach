/** The few line icons the dashboard uses, drawn inline so nothing loads from elsewhere. */

interface IconProps {
  readonly className?: string;
}

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  viewBox: "0 0 24 24",
  "aria-hidden": true,
} as const;

export function IconCheck({ className = "size-4" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconX({ className = "size-4" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconMenu({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconStop({ className = "size-5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z" />
      <path d="M12 8v5M12 16.5h.01" />
    </svg>
  );
}

export function IconExternal({ className = "size-3.5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4" />
    </svg>
  );
}

/** Points right when a row is closed; turned a quarter down when it is open. */
export function IconChevron({ className = "size-3.5" }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  );
}
