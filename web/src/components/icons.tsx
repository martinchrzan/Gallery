/**
 * Inline stroke icons. Kept as a handful of small components rather than an
 * icon dependency: the whole set is a few hundred bytes and inherits
 * `currentColor`, so it always matches the surrounding text.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flex: '0 0 auto' }}
    >
      {children}
    </svg>
  );
}

export const IconClose = (props: IconProps) => (
  <Svg {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconChevronLeft = (props: IconProps) => (
  <Svg {...props}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconChevronRight = (props: IconProps) => (
  <Svg {...props}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const IconInfo = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-5M12 8h.01" />
  </Svg>
);

export const IconDownload = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3v12M7 11l5 5 5-5M4 20h16" />
  </Svg>
);

/** Arrows pointing outward — "zoom to actual size". */
export const IconExpand = (props: IconProps) => (
  <Svg {...props}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-8 8M3 21l8-8" />
  </Svg>
);

/** Arrows pointing inward — "fit to screen". */
export const IconCollapse = (props: IconProps) => (
  <Svg {...props}>
    <path d="M15 9h6M15 9V3M9 15H3M9 15v6M21 3l-6 6M3 21l6-6" />
  </Svg>
);

export const IconZoom = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Svg>
);

/** A photo frame with an arrow curving over it — "turn this a quarter turn". */
export const IconRotate = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 21a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1Z" />
    <path d="M12 6h4a4 4 0 0 1 4 4v1" />
    <path d="m10 4 2 2-2 2" />
  </Svg>
);

export const IconSettings = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </Svg>
);

export const IconFolder = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1Z" />
  </Svg>
);

export const IconFile = (props: IconProps) => (
  <Svg {...props}>
    <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z" />
    <path d="M14 3v4h4" />
  </Svg>
);

export const IconImage = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <circle cx="8.5" cy="9.5" r="1.5" />
    <path d="m21 16-5-5-6 6-2-2-5 5" />
  </Svg>
);

export const IconSignOut = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </Svg>
);

export const IconUsers = (props: IconProps) => (
  <Svg {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconCopy = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

export const IconArchive = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />
    <path d="M3 8V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3M10 12h4" />
  </Svg>
);
