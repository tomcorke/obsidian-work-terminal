import { describe, expect, it, vi } from "vitest";
import { startOpenCodeWebSession } from "./OpenCodeWebSession";

describe("startOpenCodeWebSession", () => {
  it("creates a session, submits the prompt, and returns its web route", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "ses_test123" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await startOpenCodeWebSession({
      serverUrl: "http://127.0.0.1:4096/",
      cwd: "/tmp/project",
      title: "Fix the thing",
      prompt: "Task context",
      request,
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL("http://127.0.0.1:4096/session?directory=%2Ftmp%2Fproject"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: undefined,
        body: JSON.stringify({ title: "Fix the thing" }),
      },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL("http://127.0.0.1:4096/session/ses_test123/prompt_async?directory=%2Ftmp%2Fproject"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: undefined,
        body: JSON.stringify({ parts: [{ type: "text", text: "Task context" }] }),
      },
    );
    expect(result).toEqual({
      sessionId: "ses_test123",
      pageUrl: "http://127.0.0.1:4096/aHR0cDovLzEyNy4wLjAuMTo0MDk2/session/ses_test123",
    });
  });

  it("rejects invalid create-session responses without sending a prompt", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await expect(
      startOpenCodeWebSession({
        serverUrl: "http://127.0.0.1:4096/",
        cwd: "/tmp/project",
        title: "Task",
        prompt: "Context",
        request,
      }),
    ).rejects.toThrow("invalid session");
    expect(request).toHaveBeenCalledOnce();
  });
});
