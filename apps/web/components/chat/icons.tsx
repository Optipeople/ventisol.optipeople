// The icons Opti Assist takes from lucide-react, drawn here because this app
// does not install lucide and @optipeople/ui has no such icons yet. Same
// 24 px grid and stroke as lucide, so they can be swapped for shared icons
// once the package has them.

import type { ReactNode, SVGAttributes } from "react";

type IconProps = SVGAttributes<SVGSVGElement>;

function icon(path: ReactNode) {
  return function Icon(props: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={24}
        height={24}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {path}
      </svg>
    );
  };
}

export const PanelLeftCloseIcon = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="m16 15-3-3 3-3" />
  </>
);

export const PanelLeftOpenIcon = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
    <path d="m14 9 3 3-3 3" />
  </>
);

export const MessageSquareIcon = icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);

export const ArrowUpIcon = icon(
  <>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </>
);

export const ArrowDownIcon = icon(
  <>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </>
);

export const SquareIcon = icon(<rect width="18" height="18" x="3" y="3" rx="2" />);

export const CopyIcon = icon(
  <>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>
);
