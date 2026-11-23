import { describe, expect, it, vi } from "vitest";

import { supportsXtermWebglFontRendering } from "./WebglCompatibility";

function documentWithCanvasFont(result: "accepted" | "rejected" | "no-context"): {
  doc: Document;
  setFont: ReturnType<typeof vi.fn>;
} {
  if (result === "no-context") {
    const doc = { createElement: vi.fn(() => ({ getContext: vi.fn(() => null) })) };
    return { doc: doc as unknown as Document, setFont: vi.fn() };
  }

  const setFont = vi.fn();
  const context = { font: "10px sans-serif" as string };
  Object.defineProperty(context, "font", {
    configurable: true,
    get: () =>
      result === "accepted" && setFont.mock.lastCall ? "24px monospace" : "10px sans-serif",
    set: setFont,
  });
  const doc = { createElement: vi.fn(() => ({ getContext: vi.fn(() => context) })) };
  return { doc: doc as unknown as Document, setFont };
}

describe("supportsXtermWebglFontRendering", () => {
  it("probes with the same malformed shorthand xterm's WebGL addon assigns", () => {
    const { doc, setFont } = documentWithCanvasFont("accepted");

    supportsXtermWebglFontRendering(doc);

    expect(setFont).toHaveBeenCalledWith(" normal 24px monospace");
  });

  it("accepts runtimes that apply xterm's WebGL font shorthand", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont("accepted").doc)).toBe(true);
  });

  it("rejects runtimes that leave the canvas default font in place", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont("rejected").doc)).toBe(false);
  });

  it("rejects runtimes without a 2D canvas context", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont("no-context").doc)).toBe(false);
  });
});
