import { describe, expect, it } from "vitest";
import { extractLoopbackUrl, OpenCodeWebUrlParser } from "./OpenCodeWebUrlParser";

describe("OpenCodeWebUrlParser", () => {
  it("extracts OpenCode's ANSI-formatted loopback URL across output chunks", () => {
    const parser = new OpenCodeWebUrlParser();

    expect(parser.push("\u001b[94mWeb interface: http://127.0.")).toBeNull();
    expect(parser.push("0.1:4096/\u001b[0m\r\n")).toBe("http://127.0.0.1:4096/");
  });

  it("rejects non-loopback URLs", () => {
    expect(extractLoopbackUrl("Web interface: https://example.com/")).toBeNull();
    expect(extractLoopbackUrl("Web interface: http://localhost.evil:4096/")).toBeNull();
  });
});
