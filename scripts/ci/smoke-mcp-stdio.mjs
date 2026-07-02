#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [command, dbPath] = process.argv.slice(2);
if (!command || !dbPath) {
  console.error("Usage: smoke-mcp-stdio.mjs <command> <db-path>");
  process.exit(2);
}

const dataDir = dirname(resolve(dbPath));
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  resolve(dataDir, "data.json"),
  JSON.stringify({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }, null, 2),
);

const child = spawn(command, ["--db", dbPath, "--nowait"], {
  stdio: ["pipe", "pipe", "pipe"],
  shell: process.platform === "win32",
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

let stdoutBuffer = "";
let nextId = 1;
let initialized = false;
const pending = new Map();

const fail = (message) => {
  child.kill("SIGTERM");
  console.error(message);
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
};

const encodeMessage = (message) => `${JSON.stringify(message)}\n`;

const sendRequest = (method, params = {}) => {
  const id = nextId;
  nextId += 1;
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
  return new Promise((resolveResponse, rejectResponse) => {
    pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
  });
};

const sendNotification = (method, params = {}) => {
  child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
};

const handleMessage = (message) => {
  if (typeof message.id === "number" && pending.has(message.id)) {
    const { resolve: resolveResponse, reject: rejectResponse } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectResponse(new Error(JSON.stringify(message.error)));
    else resolveResponse(message.result);
  }
};

const parseMessages = () => {
  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex < 0) return;
    const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    if (line.trim()) handleMessage(JSON.parse(line));
  }
};

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  parseMessages();
});

child.on("error", (error) => fail("Failed to start MCP process: " + error.message));
child.on("exit", (code, signal) => {
  if (!initialized || pending.size > 0) {
    fail("MCP process exited early with code " + (code ?? "null") + " signal " + (signal ?? "null"));
  }
});

const timeout = setTimeout(() => fail("Timed out waiting for MCP smoke test"), 15000);

try {
  await sendRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mindwtr-mcp-smoke", version: "0.0.0" },
  });
  initialized = true;
  sendNotification("notifications/initialized");
  const tools = await sendRequest("tools/list");
  if (!Array.isArray(tools?.tools) || !tools.tools.some((tool) => tool.name === "mindwtr_list_tasks")) {
    throw new Error("mindwtr_list_tasks was not advertised");
  }
  const result = await sendRequest("tools/call", {
    name: "mindwtr_list_tasks",
    arguments: { limit: 5 },
  });
  const text = result?.content?.[0]?.text;
  const payload = JSON.parse(text);
  if (!Array.isArray(payload.tasks)) {
    throw new Error("mindwtr_list_tasks did not return a tasks array");
  }
  clearTimeout(timeout);
  child.stdin.end();
  child.kill("SIGTERM");
  console.log("MCP stdio smoke test passed");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
