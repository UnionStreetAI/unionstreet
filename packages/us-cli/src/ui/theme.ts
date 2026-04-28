/**
 * Brand: Union Street AI — "the void and the laser."
 * Pure black canvas, hairline structure, electric-orange accent.
 * Sharp edges. Mono tags as section eyebrows. Single accent per screen.
 *
 * Source of truth: UnionStreetAI/design/colors_and_type.css
 */

export const C = {
  // surfaces (kept for completeness; we don't fill backgrounds — let the user's terminal be the void)
  void: "#000000",
  surface1: "#0A0A0A",
  surface2: "#111111",
  surface3: "#181818",

  // foreground hierarchy
  fg1: "#FFFFFF", // primary headings, key UI
  fg2: "#E5E5E5", // body
  fg3: "#A0A0A0", // secondary
  fg4: "#888888", // meta / captions
  fg5: "#555555", // disabled / very low priority

  // hairline borders
  border1: "#141414", // default hairline
  border2: "#242424", // stronger separator
  border3: "#3D3D3D", // focused (non-laser)

  // the laser — single chromatic accent
  laser: "#FF5B14",
  laserHot: "#FF7A3D",
  laserDim: "#C8430E",

  // semantic — escape hatch only; prefer greyscale + glyph
  success: "#4ADE80",
  warning: "#FACC15",
  danger: "#FF4D4D",
} as const;

/** opentui text attribute bitmask — bold = 1 */
export const ATTR_BOLD = 1;

// ---------- markdown syntax style ----------

import { RGBA, SyntaxStyle } from "@opentui/core";

/**
 * Brand-aligned styles for the opentui `<markdown>` renderer. The parser
 * maps tree-sitter-like scopes to these styles. Only scopes commonly used
 * by markdown text (headings/bold/italic/links/code/lists/quote) need to
 * be defined; everything else falls back to `default`.
 */
let _markdownSyntax: SyntaxStyle | null = null;
export function markdownSyntax(): SyntaxStyle {
  if (_markdownSyntax) return _markdownSyntax;
  // Scope names below are the EXACT chunks emitted by opentui's markdown
  // parser (verified against the renderable's source). Anything else is
  // ignored. Don't add speculative scopes — they silently no-op.
  _markdownSyntax = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(C.fg2) },

    // emphasis — note: it's `markup.strong`, NOT `markup.bold`
    "markup.strong": { fg: RGBA.fromHex(C.fg1), bold: true },
    "markup.italic": { fg: RGBA.fromHex(C.fg2), italic: true },
    "markup.strikethrough": { fg: RGBA.fromHex(C.fg5) },

    // headings
    "markup.heading": { fg: RGBA.fromHex(C.fg1), bold: true },

    // links — laser is the brand "active" accent
    "markup.link": { fg: RGBA.fromHex(C.laser) },
    "markup.link.label": { fg: RGBA.fromHex(C.fg1) },
    "markup.link.url": { fg: RGBA.fromHex(C.laser), underline: true },

    // code (inline + fenced)
    "markup.raw": { fg: RGBA.fromHex(C.fg3) },
  });
  return _markdownSyntax;
}
