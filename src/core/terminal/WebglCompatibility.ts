const WEBGL_FONT_PROBE = " normal 24px monospace";

/**
 * Detect Chromium builds that reject the leading whitespace in xterm's WebGL
 * canvas font shorthand. In affected Electron releases the assignment is
 * ignored and glyphs render with the 10px canvas default inside normal cells.
 */
export function supportsXtermWebglFontRendering(doc: Document = document): boolean {
  const canvas = doc.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;

  context.font = WEBGL_FONT_PROBE;
  return context.font !== "10px sans-serif";
}
