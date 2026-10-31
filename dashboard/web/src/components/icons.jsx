/**
 * The glyph set the page rail uses.
 *
 * Six marks, drawn inline as SVG strokes in the 24x24 grid: no icon package to approve, no
 * font to ship, and they inherit `currentColor`, so a glyph is the same ink as the label next
 * to it and follows the palette on its own.
 *
 * The two page marks mirror the graphic each page is built from - the ledger is a table of
 * rows, the lifetime page is a cumulative line - so the collapsed rail spells out the same
 * thing the expanded rail does.
 */

/**
 * Shared stroke settings, so every glyph has the same weight and joins.
 * @param {{ children: React.ReactNode }} props
 * @returns {JSX.Element}
 */
const Glyph = ({ children }) => (
  <svg
    className="icon"
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

/** A ruled page: the session ledger. @returns {JSX.Element} */
export const IconLedger = () => (
  <Glyph>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M8.5 3.5v17" />
    <path d="M11.5 9h5.5M11.5 13h5.5M11.5 17h3.5" />
  </Glyph>
);

/** A rising line: the lifetime cumulative curve. @returns {JSX.Element} */
export const IconLifetime = () => (
  <Glyph>
    <path d="M3.5 20h17" />
    <path d="M4 16.5l4.5-5 3.5 3 4-6 4 4" />
    <circle cx="19.5" cy="12" r="1.4" />
  </Glyph>
);

/** Sun: the light palette. @returns {JSX.Element} */
export const IconLight = () => (
  <Glyph>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </Glyph>
);

/** Crescent: the dark palette. @returns {JSX.Element} */
export const IconDark = () => (
  <Glyph>
    <path d="M19 15.5A8 8 0 0 1 8.5 5a8 8 0 1 0 10.5 10.5z" />
  </Glyph>
);

/** Half-filled circle: follow the operating system. @returns {JSX.Element} */
export const IconAuto = () => (
  <Glyph>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
  </Glyph>
);

/**
 * Chevrons for the rail's collapse control; the pointing direction is the direction the
 * control moves the rail.
 * @param {{ direction: "left" | "right" }} props
 * @returns {JSX.Element}
 */
export const IconChevron = ({ direction }) => (
  <Glyph>
    {direction === "left" ? <path d="M14.5 6.5 9 12l5.5 5.5" /> : <path d="M9.5 6.5 15 12l-5.5 5.5" />}
  </Glyph>
);

/** Three lines: opens the drawer on a phone. @returns {JSX.Element} */
export const IconMenu = () => (
  <Glyph>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
);

/** A cross: closes the drawer on a phone. @returns {JSX.Element} */
export const IconClose = () => (
  <Glyph>
    <path d="M6 6l12 12M18 6 6 18" />
  </Glyph>
);
