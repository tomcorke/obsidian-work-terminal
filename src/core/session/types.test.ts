import { describe, it, expect } from "vitest";
import type { PersistedSession, SessionType } from "./types";

describe("PersistedSession", () => {
  it("has version field set to 1", () => {
    const session: PersistedSession = {
      version: 1,
      taskPath: "2 - Areas/Tasks/active/my-task.md",
      agentSessionId: "abc-123",
      label: "Agent 1",
      sessionType: "claude-with-context",
      savedAt: "2026-03-27T10:00:00.000Z",
    };

    expect(session.version).toBe(1);
  });

  it("round-trip serialization preserves all fields", () => {
    const original: PersistedSession = {
      version: 1,
      taskPath: "2 - Areas/Tasks/active/my-task.md",
      agentSessionId: "session-uuid-456",
      label: "Claude 2",
      sessionType: "claude",
      savedAt: "2026-03-27T12:30:00.000Z",
    };

    const json = JSON.stringify(original);
    const restored: PersistedSession = JSON.parse(json);

    expect(restored.version).toBe(original.version);
    expect(restored.taskPath).toBe(original.taskPath);
    expect(restored.agentSessionId).toBe(original.agentSessionId);
    expect(restored.label).toBe(original.label);
    expect(restored.sessionType).toBe(original.sessionType);
    expect(restored.savedAt).toBe(original.savedAt);
  });

  it("supports all session types", () => {
    const types: SessionType[] = [
      "shell",
      "claude",
      "claude-with-context",
      "copilot",
      "copilot-with-context",
      "strands",
      "strands-with-context",
    ];
    for (const sessionType of types) {
      const session: PersistedSession = {
        version: 1,
        taskPath: "path",
        agentSessionId: "id",
        label: "label",
        sessionType,
        savedAt: new Date().toISOString(),
      };
      expect(session.sessionType).toBe(sessionType);
    }
  });
});
