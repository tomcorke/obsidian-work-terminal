import { describe, it, expect } from "vitest";
import { isSessionType, SESSION_TYPES, type PersistedSession, type SessionType } from "./types";

describe("PersistedSession", () => {
  it("stores the durable schema version", () => {
    const session: PersistedSession = {
      version: 2,
      taskPath: "2 - Areas/Tasks/active/my-task.md",
      claudeSessionId: "abc-123",
      label: "Agent 1",
      sessionType: "claude-with-context",
      savedAt: "2026-03-27T10:00:00.000Z",
      recoveryMode: "resume",
      cwd: "/vault",
      command: "claude",
      commandArgs: ["claude", "--resume", "abc-123"],
    };

    expect(session.version).toBe(2);
  });

  it("round-trip serialization preserves all fields", () => {
    const original: PersistedSession = {
      version: 2,
      taskPath: "2 - Areas/Tasks/active/my-task.md",
      claudeSessionId: "session-uuid-456",
      label: "Claude 2",
      sessionType: "claude",
      savedAt: "2026-03-27T12:30:00.000Z",
      recoveryMode: "resume",
      cwd: "/vault",
      command: "claude",
      commandArgs: ["claude", "--resume", "session-uuid-456"],
    };

    const json = JSON.stringify(original);
    const restored: PersistedSession = JSON.parse(json);

    expect(restored.version).toBe(original.version);
    expect(restored.taskPath).toBe(original.taskPath);
    expect(restored.claudeSessionId).toBe(original.claudeSessionId);
    expect(restored.label).toBe(original.label);
    expect(restored.sessionType).toBe(original.sessionType);
    expect(restored.savedAt).toBe(original.savedAt);
    expect(restored.recoveryMode).toBe(original.recoveryMode);
    expect(restored.cwd).toBe(original.cwd);
    expect(restored.command).toBe(original.command);
    expect(restored.commandArgs).toEqual(original.commandArgs);
  });

  it("supports all session types", () => {
    const types: SessionType[] = [...SESSION_TYPES];
    for (const sessionType of types) {
      const session: PersistedSession = {
        version: 2,
        taskPath: "path",
        claudeSessionId: sessionType === "shell" ? null : "id",
        label: "label",
        sessionType,
        savedAt: new Date().toISOString(),
        recoveryMode: sessionType === "shell" ? "relaunch" : "resume",
        cwd: "/vault",
        command: sessionType === "shell" ? "/bin/zsh" : "agent",
        commandArgs: sessionType === "shell" ? undefined : ["agent", "--resume", "id"],
      };
      expect(session.sessionType).toBe(sessionType);
    }
  });

  it("validates unknown session types", () => {
    expect(isSessionType("claude")).toBe(true);
    expect(isSessionType("unknown")).toBe(false);
    expect(isSessionType(null)).toBe(false);
  });
});
