import { describe, expect, it, vi } from "vitest";

import { supportsXtermWebglFontRendering } from "./WebglCompatibility";

function documentWithCanvasFont(result: string | null): Document {
  const context = result
    ? {
        font: "10px sans-serif",
      }
    : null;
  const canvas = {
    getContext: vi.fn(() => context),
  };
  const doc = {
    createElement: vi.fn(() => canvas),
  };

  if (context && result !== "accepted") {
    Object.defineProperty(context, "font", {
      get: () => "10px sans-serif",
      set: vi.fn(),
    });
  }

  return doc as unknown as Document;
}

describe("supportsXtermWebglFontRendering", () => {
  it("accepts runtimes that apply xterm's WebGL font shorthand", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont("accepted"))).toBe(true);
  });

  it("rejects runtimes that leave the canvas default font in place", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont("rejected"))).toBe(false);
  });

  it("rejects runtimes without a 2D canvas context", () => {
    expect(supportsXtermWebglFontRendering(documentWithCanvasFont(null))).toBe(false);
  });
});
