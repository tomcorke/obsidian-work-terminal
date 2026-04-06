import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readResumeEventMock, cleanupStaleEventsMock } = vi.hoisted(() => ({
  readResumeEventMock: vi.fn(),
  cleanupStaleEventsMock: vi.fn(),
}));

vi.mock("../claude/ClaudeHookManager", () => ({
  readResumeEvent: readResumeEventMock,
  cleanupStaleEvents: cleanupStaleEventsMock,
}));

import { AgentSessionTracker } from "./AgentSessionTracker";

describe("AgentSessionTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    readResumeEventMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with the initial session ID", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");
    expect(tracker.sessionId).toBe("session-abc");
    tracker.dispose();
  });

  it("polls for hook events on interval", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");

    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledWith("session-abc");

    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it("updates session ID when hook event is found", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-old");

    readResumeEventMock.mockReturnValueOnce({ newSessionId: "session-new" });

    vi.advanceTimersByTime(2000);

    expect(tracker.sessionId).toBe("session-new");
    tracker.dispose();
  });

  it("fires onSessionChange callback when session changes", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-old");
    const callback = vi.fn();
    tracker.onSessionChange = callback;

    readResumeEventMock.mockReturnValueOnce({ newSessionId: "session-new" });
    vi.advanceTimersByTime(2000);

    expect(callback).toHaveBeenCalledWith("session-new");
    tracker.dispose();
  });

  it("cleans up stale events after finding a hook event", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-old");

    readResumeEventMock.mockReturnValueOnce({ newSessionId: "session-new" });
    vi.advanceTimersByTime(2000);

    expect(cleanupStaleEventsMock).toHaveBeenCalled();
    tracker.dispose();
  });

  it("continues polling even if cleanupStaleEvents throws", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-old");

    readResumeEventMock.mockReturnValueOnce({ newSessionId: "session-new" });
    cleanupStaleEventsMock.mockImplementationOnce(() => {
      throw new Error("cleanup failed");
    });

    vi.advanceTimersByTime(2000);
    expect(tracker.sessionId).toBe("session-new");

    readResumeEventMock.mockReturnValue(null);
    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it("stops polling after dispose", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");

    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(1);

    tracker.dispose();

    vi.advanceTimersByTime(4000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(1);
  });

  it("dispose is idempotent", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");
    tracker.dispose();
    tracker.dispose(); // should not throw
  });

  it("stops polling after 5 consecutive errors", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");

    readResumeEventMock.mockImplementation(() => {
      throw new Error("poll error");
    });

    // 5 errors should trigger stop
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
    }

    expect(readResumeEventMock).toHaveBeenCalledTimes(5);

    // 6th tick should not poll (timer stopped)
    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(5);

    tracker.dispose();
  });

  it("resets error counter on successful poll", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");

    // 4 consecutive errors
    readResumeEventMock
      .mockImplementationOnce(() => {
        throw new Error("error 1");
      })
      .mockImplementationOnce(() => {
        throw new Error("error 2");
      })
      .mockImplementationOnce(() => {
        throw new Error("error 3");
      })
      .mockImplementationOnce(() => {
        throw new Error("error 4");
      })
      .mockReturnValueOnce(null) // success - resets counter
      .mockImplementationOnce(() => {
        throw new Error("error 5");
      })
      .mockImplementationOnce(() => {
        throw new Error("error 6");
      })
      .mockReturnValue(null);

    // 4 errors then 1 success
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
    }

    // 2 more errors - should still be polling since counter was reset
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);

    expect(readResumeEventMock).toHaveBeenCalledTimes(7);
    tracker.dispose();
  });

  it("feedInput is a no-op", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-abc");
    // Should not throw
    tracker.feedInput("/resume");
    tracker.feedInput("any data");
    tracker.dispose();
  });

  it("survives onSessionChange callback throwing", () => {
    const tracker = new AgentSessionTracker("/cwd", "session-old");
    tracker.onSessionChange = () => {
      throw new Error("callback error");
    };

    readResumeEventMock.mockReturnValueOnce({ newSessionId: "session-new" });
    vi.advanceTimersByTime(2000);

    // Session should still be updated despite callback error
    expect(tracker.sessionId).toBe("session-new");

    // Polling should continue
    readResumeEventMock.mockReturnValue(null);
    vi.advanceTimersByTime(2000);
    expect(readResumeEventMock).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });
});
