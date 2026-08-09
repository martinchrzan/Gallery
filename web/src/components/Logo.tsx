/**
 * The app mark: two overlapping rounded squares — a photo behind a photo — with
 * the lens dot on the front one. Inlined rather than loaded as an asset file so
 * it paints with the first render instead of after a round trip, and so the
 * brand row never reflows waiting on it.
 *
 * The colours are fixed, not `currentColor`: this is the logo, and it should
 * read the same everywhere it appears.
 */

interface LogoProps {
  size?: number;
  className?: string;
}

export function Logo({ size = 28, className }: LogoProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flex: '0 0 auto' }}
    >
      {/* The front square is the app's --accent exactly; keep the two in step. */}
      <rect x="0" y="20" width="52" height="52" rx="16" fill="#7DA6F2" />
      <rect x="20" y="0" width="52" height="52" rx="16" fill="#2563EB" />
      <circle cx="46" cy="26" r="9" fill="#F4F8FF" />
    </svg>
  );
}
