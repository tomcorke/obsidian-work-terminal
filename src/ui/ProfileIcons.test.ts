// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createProfileIcon } from "./ProfileIcons";
import type { ProfileIcon } from "../core/agents/AgentProfile";

describe("ProfileIcons", () => {
  describe("createProfileIcon", () => {
    it("returns null for undefined icon", () => {
      expect(createProfileIcon(undefined)).toBeNull();
    });

    it("returns null for unrecognised icon name", () => {
      expect(createProfileIcon("nonexistent" as ProfileIcon)).toBeNull();
    });

    it("returns an SVG element with correct size", () => {
      const svg = createProfileIcon("terminal", 16);
      expect(svg).toBeInstanceOf(SVGSVGElement);
      expect(svg!.getAttribute("width")).toBe("16");
      expect(svg!.getAttribute("height")).toBe("16");
    });

    it("defaults to size 14", () => {
      const svg = createProfileIcon("terminal");
      expect(svg!.getAttribute("width")).toBe("14");
      expect(svg!.getAttribute("height")).toBe("14");
    });

    it("sets viewBox on all SVGs", () => {
      const svg = createProfileIcon("bot");
      expect(svg!.getAttribute("viewBox")).toBeTruthy();
    });
  });

  describe("branded icons", () => {
    const brandedIcons: ProfileIcon[] = ["claude", "copilot", "aws", "skyscanner", "bee", "pi"];

    for (const icon of brandedIcons) {
      it(`creates ${icon} icon with path elements`, () => {
        const svg = createProfileIcon(icon);
        expect(svg).toBeInstanceOf(SVGSVGElement);
        const paths = svg!.querySelectorAll("path");
        expect(paths.length).toBeGreaterThan(0);
      });
    }

    it("claude icon uses 24x24 viewBox", () => {
      const svg = createProfileIcon("claude");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    });

    it("copilot icon uses 24x24 viewBox", () => {
      const svg = createProfileIcon("copilot");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    });

    it("aws icon uses 24x24 viewBox", () => {
      const svg = createProfileIcon("aws");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    });

    it("skyscanner icon uses padded viewBox for original coordinates", () => {
      const svg = createProfileIcon("skyscanner");
      expect(svg!.getAttribute("viewBox")).toBe("91 57 210 210");
    });

    it("pi icon uses 800x800 viewBox from official logo", () => {
      const svg = createProfileIcon("pi");
      expect(svg!.getAttribute("viewBox")).toBe("0 0 800 800");
    });

    it("pi icon has 2 path elements (P shape with cutout + i dot)", () => {
      const svg = createProfileIcon("pi");
      const paths = svg!.querySelectorAll("path");
      expect(paths.length).toBe(2);
    });

    it("pi icon P shape uses evenodd fill-rule for cutout", () => {
      const svg = createProfileIcon("pi");
      const firstPath = svg!.querySelector("path");
      expect(firstPath!.getAttribute("fill-rule")).toBe("evenodd");
    });

    it("aws icon has 5 path elements (A, W, S, smile, arrowhead)", () => {
      const svg = createProfileIcon("aws");
      const paths = svg!.querySelectorAll("path");
      expect(paths.length).toBe(5);
    });

    it("skyscanner icon has 6 path elements (arc + 5 rays)", () => {
      const svg = createProfileIcon("skyscanner");
      const paths = svg!.querySelectorAll("path");
      expect(paths.length).toBe(6);
    });
  });

  describe("generic Lucide-style icons", () => {
    const genericIcons: ProfileIcon[] = [
      "terminal",
      "bot",
      "brain",
      "code",
      "rocket",
      "zap",
      "cog",
      "wrench",
      "shield",
      "globe",
      "search",
      "lightbulb",
      "flask",
      "book",
      "puzzle",
    ];

    for (const icon of genericIcons) {
      it(`creates ${icon} icon`, () => {
        const svg = createProfileIcon(icon);
        expect(svg).toBeInstanceOf(SVGSVGElement);
        expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      });
    }
  });

  describe("SVG structure", () => {
    it("path elements use currentColor fill", () => {
      const svg = createProfileIcon("claude");
      const path = svg!.querySelector("path");
      expect(path!.getAttribute("fill")).toBe("currentColor");
    });

    it("stroke paths use currentColor stroke and no fill", () => {
      const svg = createProfileIcon("terminal");
      const path = svg!.querySelector("path");
      expect(path!.getAttribute("stroke")).toBe("currentColor");
      expect(path!.getAttribute("fill")).toBe("none");
    });

    it("SVG has vertical-align middle style", () => {
      const svg = createProfileIcon("terminal");
      expect(svg!.style.verticalAlign).toBe("middle");
    });
  });
});
