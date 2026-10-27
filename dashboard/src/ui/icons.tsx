// The dashboard's icons: inline stroke SVG (1.8 px, 2 for the small marks), drawn on a 24 px
// box and sized by `size`. No icon font, no emoji. Decorative: the control they sit in names
// itself (its text, or its aria-label).
import type { ComponentChildren } from "preact";

interface Props {
  size?: number;
  class?: string;
}

function stroke(width: number, paths: ComponentChildren) {
  return ({ size = 16, class: className }: Props) => (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={width}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}

function filled(paths: ComponentChildren) {
  return ({ size = 16, class: className }: Props) => (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {paths}
    </svg>
  );
}

export const Search = stroke(
  1.8,
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </>,
);
export const Overview = stroke(
  1.8,
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);
export const Tasks = stroke(
  1.8,
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </>,
);
export const Board = stroke(
  1.8,
  <>
    <rect x="3" y="3" width="6" height="6" rx="1.5" />
    <rect x="15" y="3" width="6" height="6" rx="1.5" />
    <rect x="15" y="15" width="6" height="6" rx="1.5" />
    <path d="M9 6h6M18 9v6" />
  </>,
);
export const Settings = stroke(
  1.8,
  <>
    <path d="M3 7l9-4 9 4-9 4-9-4z" />
    <path d="M3 7v10l9 4 9-4V7" />
    <path d="M12 11v10" />
  </>,
);
export const Filters = stroke(
  1.8,
  <>
    <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="18" r="2" />
  </>,
);
export const Plus = stroke(1.8, <path d="M12 5v14M5 12h14" />);
export const Minus = stroke(1.8, <path d="M5 12h14" />);
export const Sync = stroke(
  1.8,
  <>
    <path d="M20 11a8 8 0 0 0-14.9-3.9L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.9 3.9L20 16" />
    <path d="M20 20v-4h-4" />
  </>,
);
export const External = stroke(
  1.8,
  <>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>,
);
export const Sidebar = stroke(
  1.8,
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
export const System = stroke(
  1.8,
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);
export const Sun = stroke(
  1.8,
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);
export const Moon = stroke(1.8, <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />);
export const SignOut = stroke(
  1.8,
  <>
    <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
    <path d="M10 17l-5-5 5-5M5 12h11" />
  </>,
);
export const Branch = stroke(
  1.8,
  <>
    <circle cx="6" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="18" r="2" />
    <path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4" />
  </>,
);
export const Copy = stroke(
  1.8,
  <>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
  </>,
);
export const Download = stroke(1.8, <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />);
export const ArrowDown = stroke(1.8, <path d="M12 5v14M6 13l6 6 6-6" />);
export const Expand = stroke(1.8, <path d="M7 10l5-5 5 5M7 14l5 5 5-5" />);
export const Bug = stroke(
  1.8,
  <>
    <rect x="7" y="7" width="10" height="13" rx="5" />
    <path d="M12 7V4M4 12h3M17 12h3M5 18l2.5-1.5M19 18l-2.5-1.5M5 6l2.5 1.5M19 6l-2.5 1.5" />
  </>,
);
export const Idea = stroke(
  1.8,
  <>
    <path d="M9 18h6M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
  </>,
);
export const Bell = stroke(
  1.8,
  <>
    <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </>,
);
export const Chart = stroke(1.8, <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);
export const Anchor = stroke(
  2,
  <>
    <circle cx="12" cy="5" r="2" />
    <path d="M12 7v14M5 13H3a9 9 0 0 0 18 0h-2M8 10h8" />
  </>,
);
export const ChevronRight = stroke(2, <path d="M9 6l6 6-6 6" />);
export const ChevronLeft = stroke(2, <path d="M15 6l-6 6 6 6" />);
export const ChevronDown = stroke(2, <path d="M6 9l6 6 6-6" />);
export const ChevronUp = stroke(2, <path d="M18 15l-6-6-6 6" />);
export const Close = stroke(2, <path d="M6 6l12 12M18 6L6 18" />);
export const Check = stroke(2, <path d="M5 12l5 5 9-10" />);
export const Pencil = stroke(1.8, <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />);
export const Alert = stroke(
  2,
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" />
  </>,
);
export const Warning = stroke(
  2,
  <>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v4M12 17h.01" />
  </>,
);
export const Play = filled(<path d="M7 5l12 7-12 7z" />);
export const Stop = filled(<rect x="5" y="5" width="14" height="14" rx="2" />);
export const More = filled(
  <>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </>,
);
export const Grip = filled(
  <>
    <circle cx="9" cy="6" r="1.5" />
    <circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" />
    <circle cx="15" cy="18" r="1.5" />
  </>,
);
