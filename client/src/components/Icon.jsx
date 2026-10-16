const P = {
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
  loop: (
    <>
      <path d="M3 7.5V7a3 3 0 0 1 3-3h6.5" />
      <path d="M10.5 2l2 2-2 2" />
      <path d="M13 8.5V9a3 3 0 0 1-3 3H3.5" />
      <path d="M5.5 14l-2-2 2-2" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  grip: (
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </g>
  ),
  import: (
    <>
      <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2" />
      <path d="M2.5 11.5v1.5h11v-1.5" />
    </>
  ),
  pull: (
    <>
      <path d="M8 2.5v7M5 6.8L8 9.8l3-3" />
      <path d="M3 12.5h10" />
    </>
  ),
  star: <path d="M8 2.3l1.75 3.6 3.95.55-2.86 2.77.68 3.93L8 11.3l-3.52 1.85.68-3.93L2.3 6.45l3.95-.55z" />,
  starOn: <path d="M8 2.3l1.75 3.6 3.95.55-2.86 2.77.68 3.93L8 11.3l-3.52 1.85.68-3.93L2.3 6.45l3.95-.55z" fill="currentColor" />,
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </g>
  ),
  folder: <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  up: <path d="M4.5 9.5L8 6l3.5 3.5" />,
  down: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  chevron: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  desk: <path d="M2.5 5h11M4 5v7.5M12 5v7.5" />,
  fx: (
    <>
      <path d="M7 2.5l1.2 3 3 1.2-3 1.2L7 11 5.8 7.9l-3-1.2 3-1.2z" />
      <path d="M12 10v3.5M10.25 11.75h3.5" />
    </>
  ),
  cursor: <path d="M4.5 2.5l7.5 6-3.6.6 2 3.9-1.6.8-2-3.9-2.3 2.6z" />,
  hand: <path d="M5.5 8.5V4a1 1 0 0 1 2 0v3.5m0-.5V3a1 1 0 0 1 2 0v4m0-.5V4a1 1 0 0 1 2 0v5c0 2.8-1.8 4.5-4.2 4.5-1.6 0-2.6-.8-3.4-2L2.6 9.2a1 1 0 0 1 1.6-1.1l1.3 1.4" />,
  frame: <path d="M4.5 2v12M11.5 2v12M2 4.5h12M2 11.5h12" />,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  layers: (
    <>
      <path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" />
      <path d="M2.5 8.5l5.5 3 5.5-3" />
    </>
  ),
  sideLeft: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M6.5 3v10" />
    </>
  ),
  sideRight: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M9.5 3v10" />
    </>
  ),
  trim: <path d="M5.5 3.5H3.5v9h2M10.5 3.5h2v9h-2M7 8h2" />,
  merge: <path d="M2.5 4.5h3.5l3 3.5-3 3.5H2.5M9 8h4.5M11.5 6l2 2-2 2" />,
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.6 6.6a1.5 1.5 0 1 1 2.1 1.4c-.45.25-.7.55-.7 1.1M8 10.9v.1" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="4" width="11" height="8" rx="1.5" />
      <path d="M4.5 9.5l1.2-2 1.3 3 1.4-4.5 1.3 3.5 1-1.5" />
    </>
  ),
  reset: (
    <>
      <path d="M3.6 8.6A4.5 4.5 0 1 0 5 4.4" />
      <path d="M4.6 2.2v2.6h2.6" />
    </>
  ),
  cut: (
    <>
      <circle cx="4.5" cy="11.5" r="2" />
      <circle cx="11.5" cy="11.5" r="2" />
      <path d="M5.8 10L11 2.5M10.2 10L5 2.5" />
    </>
  ),
};

export function Icon({ name, size = 16 }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}
