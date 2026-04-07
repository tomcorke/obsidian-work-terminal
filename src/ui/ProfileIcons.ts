/**
 * ProfileIcons - SVG icon factory for agent profile tab bar buttons.
 * Provides branded icons (Claude, Copilot, AWS, Skyscanner, Bee)
 * and generic Lucide-style icons.
 *
 * Branded icon sources:
 * - Claude: Simple Icons (https://simpleicons.org/?q=claude), 24x24
 * - Copilot: Simple Icons (https://simpleicons.org/?q=github-copilot), 24x24
 * - AWS: Wordmark + smile-arrow (https://simpleicons.org/?q=amazon-aws), 24x24
 * - Skyscanner: Official sunrise mark extracted from Wikimedia Commons SVG
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
  // Official Claude sparkle mark (Simple Icons, 24x24)
  const svg = makeSvg(size, "0 0 24 24");
  addPath(
    svg,
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  );
  return svg;
}

function createCopilotIcon(size: number): SVGSVGElement {
  // Official GitHub Copilot visor mark (Simple Icons, 24x24)
  const svg = makeSvg(size, "0 0 24 24");
  addPath(
    svg,
    "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z",
  );
  return svg;
}

function createAwsIcon(size: number): SVGSVGElement {
  // AWS wordmark + smile-arrow mark (Simple Icons, 24x24)
  const svg = makeSvg(size, "0 0 24 24");
  // "A" letterform (left peak)
  addPath(
    svg,
    "M8.4 14.3L6.1 4.5c-.1-.3-.2-.5-.5-.5H4.1c-.3 0-.4.2-.5.5L1 14.3c0 .2.1.4.3.4h1.8c.3 0 .4-.2.5-.4l.5-2.3h3.2l.5 2.3c.1.2.2.4.5.4h1.8c.2 0 .4-.2.3-.4zM4.5 10.2l1.2-5.4 1.2 5.4H4.5z",
  );
  // "W" letterform (center)
  addPath(
    svg,
    "M14.5 14.3l-1.8-9.8c-.1-.3-.2-.5-.5-.5h-1.5c-.3 0-.4.2-.5.5l-1 5.6 1.1 5.9c0 .2.1.3.3.3h.7c.2 0 .3-.1.3-.3l1.1-5.9 1.1 5.9c0 .2.1.3.3.3h.7c.2 0 .3-.1.3-.3l1.8-9.8c.1-.3-.1-.5-.3-.5h-1.5c-.3 0-.4.2-.5.5l-1 5.6z",
  );
  // "S" letterform (right)
  addPath(
    svg,
    "M22.4 6.1c-.5-.9-1.6-1.6-3.1-1.6-1.8 0-3 1-3 2.6 0 1.7 1.2 2.3 2.7 2.8 1.1.4 1.4.7 1.4 1.2 0 .6-.5 1-1.3 1-.9 0-1.5-.5-1.9-1.1l-1.3 1.2c.7 1 1.8 1.8 3.3 1.8 1.9 0 3.2-1 3.2-2.8 0-1.5-1-2.2-2.6-2.7-1.1-.4-1.5-.6-1.5-1.2 0-.5.4-.8 1.1-.8.7 0 1.2.4 1.5.9l1.5-1.3z",
  );
  // Smile arrow
  addPath(
    svg,
    "M2.2 17.1c3.5 2.7 8.2 4.1 12.3 4.1 3.3 0 6.8-1 9.4-3 .4-.3.1-.8-.4-.6-2.8 1.3-5.8 2-8.8 2-4.2 0-8.3-1.3-11.6-3.5-.5-.4-1 .2-.5.6l-.4.4z",
  );
  // Arrow head
  addPath(
    svg,
    "M22.8 15.7c-.3-.4-1.8-.5-2.8-.3-1 .2-1.8.6-1.6.9.1.2.4.1 1.2 0 .8-.1 2.4-.3 2.8.2.3.4-.3 2.3-.6 3.1-.1.3.1.3.4.2.9-.7 1.2-2.2 1-2.7-.1-.3-.2-.9-.4-1.4z",
  );
  return svg;
}

function createSkyscannerIcon(size: number): SVGSVGElement {
  // Official Skyscanner sunrise mark - 5 rays above a curved horizon arc.
  // Extracted from the Skyscanner horizontal lockup SVG (Wikimedia Commons).
  // Uses the original path coordinates with a square-padded viewBox for
  // correct aspect ratio at small sizes.
  const svg = makeSvg(size, "91 57 210 210");
  // Bottom arc (horizon / smile)
  addPath(
    svg,
    "M195.1 220c2.1 0 4.1-.5 6-1.6l21.9-12.6c4.4-2.5 9.5-3.6 14.6-3l26.7 3.1c5.5 1.6 5.5 1.6 6.6 1.9 1.1.3 2.4-.1 3.1-1 .9-1.1 2-2.9 2.9-5.5.8-2.5.9-4.6.8-6.1-.1-1.2-.9-2.3-2.1-2.6-8.6-2.5-46.7-12.8-97.9-12.8s-89.3 10.3-97.9 12.8c-1.2.3-2 1.4-2.1 2.6-.1 1.4 0 3.5.8 6.1.8 2.6 2 4.4 2.9 5.5.7.9 2 1.3 3.1 1 5.5-1.6 24.2-6.6 50.7-9.7 5.1-.6 10.2.5 14.6 3l21.9 12.6c1.9 1.1 4 1.6 6 1.6z",
  );
  // Vertical ray (top center)
  addPath(
    svg,
    "M203.8 137c0 2.4-1 4.6-2.5 6.2-1.6 1.6-3.7 2.5-6.2 2.5-2.4 0-4.6-1-6.2-2.5-1.6-1.6-2.5-3.7-2.5-6.2V97.7c0-1.3.8-2.3 2-2.8 1.4-.7 3.7-1.1 6.7-1.1s5.3.4 6.7 1.1c1.1.6 2 1.5 2 2.8V137z",
  );
  // Upper-left diagonal ray
  addPath(
    svg,
    "M158.6 149.1c1.2 2.1 3.1 3.5 5.3 4.1 2.2.6 4.5.3 6.6-.9 2.1-1.2 3.5-3.1 4.1-5.3.6-2.2.3-4.5-.9-6.6L154 106.3c-.6-1.1-1.9-1.5-3.1-1.4-1.6.1-3.8.9-6.4 2.4-2.6 1.5-4.4 3-5.3 4.3-.7 1-.9 2.3-.3 3.4l19.7 34.1z",
  );
  // Left horizontal ray
  addPath(
    svg,
    "M140.6 173.5c2.1 1.2 4.5 1.4 6.6.9 2.2-.6 4.1-2 5.3-4.1 1.2-2.1 1.4-4.5.9-6.6-.5-2.1-2-4.1-4.1-5.3l-34.1-19.7c-1.1-.6-2.4-.4-3.4.3-1.3.9-2.8 2.7-4.3 5.3-1.5 2.6-2.3 4.8-2.4 6.4-.1 1.3.4 2.5 1.4 3.1l34.1 19.7z",
  );
  // Upper-right diagonal ray
  addPath(
    svg,
    "M231.6 149.1c-1.2 2.1-3.1 3.5-5.3 4.1-2.2.6-4.5.3-6.6-.9-2.1-1.2-3.5-3.1-4.1-5.3-.6-2.2-.3-4.5.9-6.6l19.7-34.1c.6-1.1 1.9-1.5 3.1-1.4 1.6.1 3.8.9 6.4 2.4 2.6 1.5 4.4 3 5.3 4.3.7 1 .9 2.3.3 3.4l-19.7 34.1z",
  );
  // Right horizontal ray
  addPath(
    svg,
    "M249.6 173.5c-2.1 1.2-4.5 1.4-6.6.9-2.2-.6-4.1-2-5.3-4.1-1.2-2.1-1.4-4.5-.9-6.6.6-2.2 2-4.1 4.1-5.3l34.1-19.7c1.1-.6 2.4-.4 3.4.3 1.3.9 2.8 2.7 4.3 5.3 1.5 2.6 2.3 4.8 2.4 6.4.1 1.3-.4 2.5-1.4 3.1l-34.1 19.7z",
  );
  return svg;
}

function createPiIcon(size: number): SVGSVGElement {
  // pi (pi-coding-agent) geometric logo from https://pi.dev/logo.svg
  // Blocky "P" with inner cutout + square "i" dot, viewBox 0 0 800 800
  const svg = makeSvg(size, "0 0 800 800");
  // P shape (outer boundary clockwise, inner hole counter-clockwise via fill-rule)
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("fill", "currentColor");
  p.setAttribute("fill-rule", "evenodd");
  p.setAttribute(
    "d",
    "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z",
  );
  svg.appendChild(p);
  // i dot
  addPath(svg, "M517.36 400H634.72V634.72H517.36Z");
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
  pi: createPiIcon,
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
