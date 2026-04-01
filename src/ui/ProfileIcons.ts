/**
 * ProfileIcons - SVG icon factory for agent profile tab bar buttons.
 * Provides branded icons (Claude, Copilot, AWS, Skyscanner, Bee)
 * and generic Lucide-style icons.
 */
import type { ProfileIcon } from "../core/agents/AgentProfile";

function makeSvg(size: number, viewBox: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.style.verticalAlign = "middle";
  svg.style.marginRight = "4px";
  svg.style.flexShrink = "0";
  return svg;
}

function addPath(svg: SVGSVGElement, d: string, fill = "currentColor"): void {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", fill);
  path.setAttribute("d", d);
  svg.appendChild(path);
}

function addStrokePath(
  svg: SVGSVGElement,
  d: string,
  stroke = "currentColor",
  strokeWidth = "2",
): void {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("stroke", stroke);
  path.setAttribute("stroke-width", strokeWidth);
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("fill", "none");
  svg.appendChild(path);
}

function addCircle(
  svg: SVGSVGElement,
  cx: number,
  cy: number,
  r: number,
  stroke = "currentColor",
  fill = "none",
): void {
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", String(cx));
  circle.setAttribute("cy", String(cy));
  circle.setAttribute("r", String(r));
  circle.setAttribute("stroke", stroke);
  circle.setAttribute("stroke-width", "2");
  circle.setAttribute("fill", fill);
  svg.appendChild(circle);
}

// ---------------------------------------------------------------------------
// Branded icons
// ---------------------------------------------------------------------------

function createClaudeIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 110 130");
  addPath(
    svg,
    "m 29.05,98.54 29.14,-16.35 0.49,-1.42 -0.49,-0.79 h -1.42 l -4.87,-0.3 -16.65,-0.45 -14.44,-0.6 -13.99,-0.75 -3.52,-0.75 -3.3,-4.35 0.34,-2.17 2.96,-1.99 4.24,0.37 9.37,0.64 14.06,0.97 10.2,0.6 15.11,1.57 h 2.4 l 0.34,-0.97 -0.82,-0.6 -0.64,-0.6 -14.55,-9.86 -15.75,-10.42 -8.25,-6 -4.46,-3.04 -2.25,-2.85 -0.97,-6.22 4.05,-4.46 5.44,0.37 1.39,0.37 5.51,4.24 11.77,9.11 15.37,11.32 2.25,1.87 0.9,-0.64 0.11,-0.45 -1.01,-1.69 -8.36,-15.11 -8.92,-15.37 -3.97,-6.37 -1.05,-3.82 c -0.37,-1.57 -0.64,-2.89 -0.64,-4.5 l 4.61,-6.26 2.55,-0.82 6.15,0.82 2.59,2.25 3.82,8.74 6.19,13.76 9.6,18.71 2.81,5.55 1.5,5.14 0.56,1.57 h 0.97 v -0.9 l 0.79,-10.54 1.46,-12.94 1.42,-16.65 0.49,-4.69 2.32,-5.62 4.61,-3.04 3.6,1.72 2.96,4.24 -0.41,2.74 -1.76,11.44 -3.45,17.92 -2.25,12 h 1.31 l 1.5,-1.5 6.07,-8.06 10.2,-12.75 4.5,-5.06 5.25,-5.59 3.37,-2.66 h 6.37 l 4.69,6.97 -2.1,7.2 -6.56,8.32 -5.44,7.05 -7.8,10.5 -4.87,8.4 0.45,0.67 1.16,-0.11 17.62,-3.75 9.52,-1.72 11.36,-1.95 5.14,2.4 0.56,2.44 -2.02,4.99 -12.15,3 -14.25,2.85 -21.22,5.02 -0.26,0.19 0.3,0.37 9.56,0.9 4.09,0.22 h 10.01 l 18.64,1.39 4.87,3.22 2.92,3.94 -0.49,3 -7.5,3.82 -10.12,-2.4 -23.62,-5.62 -8.1,-2.02 h -1.12 v 0.67 l 6.75,6.6 12.37,11.17 15.49,14.4 0.79,3.56 -1.99,2.81 -2.1,-0.3 -13.61,-10.24 -5.25,-4.61 -11.89,-10.01 h -0.79 v 1.05 l 2.74,4.01 14.47,21.75 0.75,6.67 -1.05,2.17 -3.75,1.31 -4.12,-0.75 -8.47,-11.89 -8.74,-13.39 -7.05,-12 -0.86,0.49 -4.16,44.81 -1.95,2.29 -4.5,1.72 -3.75,-2.85 -1.99,-4.61 1.99,-9.11 2.4,-11.89 1.95,-9.45 1.76,-11.74 1.05,-3.9 -0.07,-0.26 -0.86,0.11 -8.85,12.15 -13.46,18.19 -10.65,11.4 -2.55,1.01 -4.42,-2.29 0.41,-4.09 2.47,-3.64 14.74,-18.75 8.89,-11.62 5.74,-6.71 -0.04,-0.97 h -0.34 l -39.15,25.42 -6.97,0.9 -3,-2.81 0.37,-4.61 1.42,-1.5 11.77,-8.1 -0.04,0.04 z",
  );
  return svg;
}

function createCopilotIcon(size: number): SVGSVGElement {
  // GitHub Copilot dual-lens visor mark
  const svg = makeSvg(size, "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute(
    "d",
    "M12 1C5.9 1 1 5 1 10.2c0 3.4 2 6.4 5 8.1V22l3.5-2.3c.8.2 1.6.3 2.5.3 6.1 0 11-4 11-9.2S18.1 1 12 1zm-3 12.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z",
  );
  svg.appendChild(path);
  return svg;
}

function createAwsIcon(size: number): SVGSVGElement {
  // Simplified AWS "smile" arrow mark
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M3 7l4 5-4 5");
  addStrokePath(svg, "M10 7l4 5-4 5");
  addStrokePath(svg, "M5 19c4 2 10 2 14-1", "currentColor", "2.5");
  return svg;
}

function createSkyscannerIcon(size: number): SVGSVGElement {
  // Simplified Skyscanner traveller mark - three overlapping circles
  const svg = makeSvg(size, "0 0 24 24");
  addCircle(svg, 12, 8, 4);
  addCircle(svg, 7, 15, 4);
  addCircle(svg, 17, 15, 4);
  return svg;
}

function createBeeIcon(size: number): SVGSVGElement {
  // Literal bee illustration
  const svg = makeSvg(size, "0 0 24 24");
  // Body (oval)
  addStrokePath(svg, "M12 9c2.5 0 4.5 1.5 4.5 4s-2 5-4.5 5-4.5-2.5-4.5-5 2-4 4.5-4z");
  // Stripes
  addStrokePath(svg, "M9 13h6");
  addStrokePath(svg, "M9 15.5h6");
  // Head
  addCircle(svg, 12, 7, 2);
  // Antennae
  addStrokePath(svg, "M10.5 5.5L9 3");
  addStrokePath(svg, "M13.5 5.5L15 3");
  // Wings
  addStrokePath(svg, "M7.5 10c-2-1.5-3-3.5-1.5-4.5 1.5-1 3 .5 3.5 2");
  addStrokePath(svg, "M16.5 10c2-1.5 3-3.5 1.5-4.5-1.5-1-3 .5-3.5 2");
  // Stinger
  addStrokePath(svg, "M12 18v1.5");
  return svg;
}

// ---------------------------------------------------------------------------
// Generic Lucide-style icons
// ---------------------------------------------------------------------------

function createTerminalIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M4 17l6-6-6-6");
  addStrokePath(svg, "M12 19h8");
  return svg;
}

function createBotIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M12 8V4H8");
  addStrokePath(svg, "M4 10a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2");
  addStrokePath(svg, "M20 10a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2");
  addStrokePath(svg, "M4 10h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9z");
  addCircle(svg, 9, 15, 1, "none", "currentColor");
  addCircle(svg, 15, 15, 1, "none", "currentColor");
  return svg;
}

function createBrainIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18z",
  );
  addStrokePath(
    svg,
    "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18z",
  );
  addStrokePath(svg, "M12 5v13");
  return svg;
}

function createCodeIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M16 18l6-6-6-6");
  addStrokePath(svg, "M8 6l-6 6 6 6");
  return svg;
}

function createRocketIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z",
  );
  addStrokePath(
    svg,
    "M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z",
  );
  addStrokePath(svg, "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0");
  addStrokePath(svg, "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5");
  return svg;
}

function createZapIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addPath(svg, "M13 2L3 14h9l-1 8 10-12h-9l1-8z");
  return svg;
}

function createCogIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  addCircle(svg, 12, 12, 3);
  return svg;
}

function createWrenchIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
  );
  return svg;
}

function createShieldIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z");
  return svg;
}

function createGlobeIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addCircle(svg, 12, 12, 10);
  addStrokePath(svg, "M2 12h20");
  addStrokePath(
    svg,
    "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  );
  return svg;
}

function createSearchIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addCircle(svg, 11, 11, 8);
  addStrokePath(svg, "M21 21l-4.35-4.35");
  return svg;
}

function createLightbulbIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5",
  );
  addStrokePath(svg, "M9 18h6");
  addStrokePath(svg, "M10 22h4");
  return svg;
}

function createFlaskIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2",
  );
  addStrokePath(svg, "M8.5 2h7");
  addStrokePath(svg, "M7 16.5h10");
  return svg;
}

function createBookIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(svg, "M4 19.5A2.5 2.5 0 0 1 6.5 17H20");
  addStrokePath(svg, "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z");
  return svg;
}

function createPuzzleIcon(size: number): SVGSVGElement {
  const svg = makeSvg(size, "0 0 24 24");
  addStrokePath(
    svg,
    "M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.743-.956l.005-.033a1.5 1.5 0 0 0-2.961-.49.94.94 0 0 1-.933.807H12.5v1.5a1.5 1.5 0 1 1-3 0V15h-1a2 2 0 0 1-2-2v-1H5a1.5 1.5 0 1 1 0-3h1.5V8a2 2 0 0 1 2-2h1V4.5a1.5 1.5 0 0 1 3 0V6h1.5a.94.94 0 0 1 .933.807 1.5 1.5 0 0 0 2.961-.49l-.005-.033c-.059-.476.273-.887.743-.956a.98.98 0 0 1 .837.276l.02.02z",
  );
  return svg;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const ICON_FACTORIES: Record<ProfileIcon, (size: number) => SVGSVGElement> = {
  terminal: createTerminalIcon,
  bot: createBotIcon,
  brain: createBrainIcon,
  code: createCodeIcon,
  rocket: createRocketIcon,
  zap: createZapIcon,
  cog: createCogIcon,
  wrench: createWrenchIcon,
  shield: createShieldIcon,
  globe: createGlobeIcon,
  search: createSearchIcon,
  lightbulb: createLightbulbIcon,
  flask: createFlaskIcon,
  book: createBookIcon,
  puzzle: createPuzzleIcon,
  bee: createBeeIcon,
  claude: createClaudeIcon,
  copilot: createCopilotIcon,
  aws: createAwsIcon,
  skyscanner: createSkyscannerIcon,
};

/**
 * Create an SVG icon element for the given profile icon name.
 * Returns null if the icon is not recognized.
 */
export function createProfileIcon(icon: ProfileIcon | undefined, size = 14): SVGSVGElement | null {
  if (!icon) return null;
  const factory = ICON_FACTORIES[icon];
  return factory ? factory(size) : null;
}
