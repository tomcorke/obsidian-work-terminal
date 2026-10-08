import { spawn, spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

describe("bundled task tab broker helper", () => {
  it("refuses to run when the authenticated caller context is absent", () => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("WORK_TERMINAL_")) delete env[key];
    }

    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "task-tab-broker.js"), "listTabs"],
      {
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("available only inside an opted-in Work Terminal agent tab");
    expect(result.stdout).toBe("");
  });

  it("does not replay a wait across broker reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-helper-"));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\wt-broker-helper-${process.pid}-${Date.now()}`
        : join(directory, "broker.sock");
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      let frames = 0;
      socket.on("data", () => {
        frames++;
        if (frames === 1) {
          socket.write(
            `${JSON.stringify({ v: 1, type: "response", id: "hello", ok: true, result: {} })}\n`,
          );
        } else {
          socket.end(
            `${JSON.stringify({ v: 1, type: "event", event: "broker.reloading", sequence: "0", data: {} })}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));

    try {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [join(process.cwd(), "task-tab-broker.js"), "waitForTab", "{}"],
          {
            env: {
              ...process.env,
              WORK_TERMINAL_BROKER_PROTOCOL: "1",
              WORK_TERMINAL_BROKER_ENDPOINT: endpoint,
              WORK_TERMINAL_TASK_ID: "task-a",
              WORK_TERMINAL_TAB_ID: "tab-a",
              WORK_TERMINAL_TAB_GENERATION: "1",
              WORK_TERMINAL_BROKER_TOKEN: "token",
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (code) => resolve({ code, stderr }));
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("list tabs again before starting a new wait");
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("handles multiple broker frames delivered in one chunk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wt-broker-helper-"));
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\wt-broker-helper-${process.pid}-${Date.now()}`
        : join(directory, "broker.sock");
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `${JSON.stringify({ v: 1, type: "response", id: "hello", ok: true, result: {} })}\n` +
            `${JSON.stringify({ v: 1, type: "response", id: "result", ok: true, result: ["active"] })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));

    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [join(process.cwd(), "task-tab-broker.js"), "listCategories"],
            {
              env: {
                ...process.env,
                WORK_TERMINAL_BROKER_PROTOCOL: "1",
                WORK_TERMINAL_BROKER_ENDPOINT: endpoint,
                WORK_TERMINAL_TASK_ID: "task-a",
                WORK_TERMINAL_TAB_ID: "tab-a",
                WORK_TERMINAL_TAB_GENERATION: "1",
                WORK_TERMINAL_BROKER_TOKEN: "token",
              },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("close", (code) => resolve({ code, stdout, stderr }));
        },
      );

      expect(result).toEqual({
        code: 0,
        stdout: `${JSON.stringify({ v: 1, type: "response", id: "result", ok: true, result: ["active"] })}\n`,
        stderr: "",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
