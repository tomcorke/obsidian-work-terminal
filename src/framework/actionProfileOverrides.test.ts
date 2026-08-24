import { describe, expect, it } from "vitest";
import { createDefaultProfile } from "../core/agents/AgentProfile";
import {
  applyActionOverrides,
  getActionOverrides,
  supportsEffortOverride,
  supportsModelOverride,
} from "./actionProfileOverrides";

describe("action profile overrides", () => {
  it("replaces existing model and effort arguments without mutating the profile", () => {
    const profile = createDefaultProfile({
      arguments: "--model old --effort low --verbose",
      agentType: "claude",
    });
    const result = applyActionOverrides(profile, { model: "portkey/gpt-5.6-sol", effort: "high" });

    expect(result.arguments).toBe("--verbose --model portkey/gpt-5.6-sol --effort high");
    expect(profile.arguments).toBe("--model old --effort low --verbose");
  });

  it("preserves the next argument when an existing override flag has no value", () => {
    const profile = createDefaultProfile({
      arguments: "--model --verbose",
      agentType: "claude",
    });

    expect(applyActionOverrides(profile, { model: "new-model", effort: "" }).arguments).toBe(
      "--verbose --model new-model",
    );
  });

  it("uses explicit profile flags for custom agents such as Pi", () => {
    const profile = createDefaultProfile({
      agentType: "custom",
      modelFlag: "--model",
      effortFlag: "--thinking",
    });
    expect(
      applyActionOverrides(profile, { model: "portkey/gpt-5.6-luna", effort: "max" }).arguments,
    ).toBe("--model portkey/gpt-5.6-luna --thinking max");
    expect(supportsModelOverride(profile)).toBe(true);
    expect(supportsEffortOverride(profile)).toBe(true);
  });

  it("does not apply unsupported overrides", () => {
    const profile = createDefaultProfile({ agentType: "custom" });
    expect(applyActionOverrides(profile, { model: "model", effort: "high" }).arguments).toBe("");
    expect(supportsModelOverride(profile)).toBe(false);
    expect(supportsEffortOverride(profile)).toBe(false);
  });

  it("reads typed settings and ignores unknown effort values", () => {
    expect(
      getActionOverrides(
        { "adapter.splitTaskModel": " model ", "adapter.splitTaskEffort": "extreme" },
        "adapter.splitTask",
      ),
    ).toEqual({ model: "model", effort: "" });
  });
});
