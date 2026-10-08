#!/usr/bin/env node
"use strict";

const net = require("net");
const crypto = require("crypto");

const MAX_FRAME_BYTES = 65_536;
const REQUIRED_CONTEXT = [
  "WORK_TERMINAL_BROKER_PROTOCOL",
  "WORK_TERMINAL_BROKER_ENDPOINT",
  "WORK_TERMINAL_TASK_ID",
  "WORK_TERMINAL_TAB_ID",
  "WORK_TERMINAL_TAB_GENERATION",
  "WORK_TERMINAL_BROKER_TOKEN",
];

if (REQUIRED_CONTEXT.some((name) => !process.env[name])) {
  console.error(
    "Task tab broker is available only inside an opted-in Work Terminal agent tab (authenticated context is absent).",
  );
  process.exit(2);
}
if (process.env.WORK_TERMINAL_BROKER_PROTOCOL !== "1") {
  console.error("Unsupported Work Terminal broker protocol.");
  process.exit(2);
}

const method = process.argv[2];
if (!method) {
  console.error("Usage: task-tab-broker.js <method> [params-json]");
  process.exit(2);
}

let params = {};
try {
  params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error();
} catch {
  console.error("params-json must be a JSON object.");
  process.exit(2);
}

const endpoint = process.env.WORK_TERMINAL_BROKER_ENDPOINT;
const token = process.env.WORK_TERMINAL_BROKER_TOKEN;
const requestId = crypto.randomUUID();

function run(attempt = 0) {
  const socket = net.createConnection(endpoint);
  let buffer = Buffer.alloc(0);
  let greeted = false;

  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ v: 1, type: "hello", id: "hello", token })}\n`);
  });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES + 1) {
      console.error("Broker response exceeded the frame limit.");
      process.exitCode = 1;
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = buffer.subarray(0, newline).toString("utf8");
    buffer = buffer.subarray(newline + 1);
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      console.error("Broker returned an invalid frame.");
      process.exitCode = 1;
      socket.destroy();
      return;
    }
    if (!greeted) {
      if (!response.ok) {
        if (response.error?.code === "AUTH_FAILED" && attempt < 4) {
          socket.destroy();
          setTimeout(() => run(attempt + 1), 100 * 2 ** attempt);
          return;
        }
        console.error(JSON.stringify(response));
        process.exitCode = 1;
        socket.end();
        return;
      }
      greeted = true;
      socket.write(`${JSON.stringify({ v: 1, type: "request", id: requestId, method, params })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exitCode = response.ok ? 0 : 1;
    socket.end();
  });
  socket.on("error", (error) => {
    if (attempt < 4 && ["ECONNREFUSED", "ENOENT", "ECONNRESET"].includes(error.code)) {
      setTimeout(() => run(attempt + 1), 100 * 2 ** attempt);
      return;
    }
    console.error(`Could not connect to the Work Terminal broker: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}

run();
