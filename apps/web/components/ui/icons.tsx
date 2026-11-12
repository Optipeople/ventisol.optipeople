import * as React from "react";

type IconProps = React.SVGAttributes<SVGSVGElement> & { size?: number };

function svg(viewBox: string, path: React.ReactNode, displayName: string) {
  const Comp = React.forwardRef<SVGSVGElement, IconProps>(
    ({ size = 16, className, ...rest }, ref) => (
      <svg
        ref={ref}
        viewBox={viewBox}
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className}
        {...rest}
      >
        {path}
      </svg>
    ),
  );
  Comp.displayName = displayName;
  return Comp;
}

export const CheckIcon = svg(
  "0 0 16 16",
  <path d="M3 8.5l3.5 3.5L13 5" />,
  "CheckIcon",
);

export const MinusIcon = svg(
  "0 0 16 16",
  <path d="M3.5 8h9" />,
  "MinusIcon",
);

export const XIcon = svg(
  "0 0 16 16",
  <path d="M4 4l8 8M12 4l-8 8" />,
  "XIcon",
);

export const CircleXIcon = svg(
  "0 0 16 16",
  <>
    <circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="none" />
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" />
  </>,
  "CircleXIcon",
);

export const DownloadIcon = svg(
  "0 0 16 16",
  <path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" />,
  "DownloadIcon",
);

export const CircleCheckIcon = svg(
  "0 0 16 16",
  <>
    <circle cx="8" cy="8" r="6.5" fill="#37c245" stroke="none" />
    <path d="M5 8.2l2 2 4-4" stroke="white" />
  </>,
  "CircleCheckIcon",
);

export const CircleInfoIcon = svg(
  "0 0 12 12",
  <>
    <circle cx="6" cy="6" r="5" fill="currentColor" stroke="none" />
    <path d="M6 5.4v3.2M6 3.7v.6" stroke="white" strokeWidth={1.4} />
  </>,
  "CircleInfoIcon",
);

export const CircleExclamationIcon = svg(
  "0 0 12 12",
  <>
    <circle cx="6" cy="6" r="5" fill="currentColor" stroke="none" />
    <path d="M6 3.4v3.2M6 8v.6" stroke="white" strokeWidth={1.4} />
  </>,
  "CircleExclamationIcon",
);

export const TriangleExclamationIcon = svg(
  "0 0 16 16",
  <>
    <path d="M8 1.6l6.5 11.4H1.5L8 1.6z" fill="currentColor" stroke="none" />
    <path d="M8 6.2v3.4M8 11v.6" stroke="white" strokeWidth={1.4} />
  </>,
  "TriangleExclamationIcon",
);

export const SearchIcon = svg(
  "0 0 16 16",
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </>,
  "SearchIcon",
);

/**
 * Outlined "i" in a ring. The filled CircleInfoIcon above reads as a solid
 * dot at the small sizes a KPI label needs. This one stays legible as an
 * "i" next to 12px uppercase text.
 */
export const InfoIcon = svg(
  "0 0 16 16",
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v3.75M8 5.1v.5" />
  </>,
  "InfoIcon",
);

export const ChevronRightIcon = svg(
  "0 0 16 16",
  <path d="M6 3l5 5-5 5" />,
  "ChevronRightIcon",
);

export const ChevronLeftIcon = svg(
  "0 0 16 16",
  <path d="M10 3L5 8l5 5" />,
  "ChevronLeftIcon",
);

export const ChevronDownIcon = svg(
  "0 0 16 16",
  <path d="M3 6l5 5 5-5" />,
  "ChevronDownIcon",
);

export const GlobeIcon = svg(
  "0 0 16 16",
  <>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c1.6 1.8 2.4 3.9 2.4 6.25S9.6 12.45 8 14.25c-1.6-1.8-2.4-3.9-2.4-6.25S6.4 3.55 8 1.75z" />
  </>,
  "GlobeIcon",
);

export const LogOutIcon = svg(
  "0 0 16 16",
  <>
    <path d="M6 2.75H3.75A1 1 0 0 0 2.75 3.75v8.5a1 1 0 0 0 1 1H6" />
    <path d="M10.5 11 13.75 8 10.5 5M13.25 8H6.25" />
  </>,
  "LogOutIcon",
);
