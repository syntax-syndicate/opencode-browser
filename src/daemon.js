#!/usr/bin/env node
/**
 * Persistent Browser Bridge Daemon
 * 
 * Runs as a background service and bridges:
 * - Chrome extension (via WebSocket on localhost)
 * - MCP server (via Unix socket)
 * 
 * This allows scheduled jobs to use browser tools even if
 * the OpenCode session that created the job isn't running.
 */

import { createServer as createNetServer } from "net";
import { WebSocketServer } from "ws";
import { existsSync, mkdirSync, unlinkSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE_DIR = join(homedir(), ".opencode-browser");
const LOG_DIR = join(BASE_DIR, "logs");
const SOCKET_PATH = join(BASE_DIR, "browser.sock");
const WS_PORT = 19222;

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "daemon.log");

function log(...args) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args.join(" ")}\n`;
  appendFileSync(LOG_FILE, message);
  console.error(message.trim());
}

log("Daemon starting...");

// State
let chromeConnection = null;
let mcpConnections = new Set();
let pendingRequests = new Map();
let requestId = 0;

// ============================================================================
// WebSocket Server for Chrome Extension
// ============================================================================

const wss = new WebSocketServer({ port: WS_PORT });

wss.on("connection", (ws) => {
  log("Chrome extension connected via WebSocket");
  chromeConnection = ws;
  
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString());
      handleChromeMessage(message);
    } catch (e) {
      log("Failed to parse Chrome message:", e.message);
    }
  });
  
  ws.on("close", () => {
    log("Chrome extension disconnected");
    chromeConnection = null;
  });
  
  ws.on("error", (err) => {
    log("Chrome WebSocket error:", err.message);
  });
});

wss.on("listening", () => {
  log(`WebSocket server listening on port ${WS_PORT}`);
});

function sendToChrome(message) {
  if (chromeConnection && chromeConnection.readyState === 1) {
    chromeConnection.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function handleChromeMessage(message) {
  log("From Chrome:", message.type);
  
  if (message.type === "tool_response") {
    const pending = pendingRequests.get(message.id);
    if (pending) {
      pendingRequests.delete(message.id);
      sendToMcp(pending.socket, {
        type: "tool_response",
        id: pending.mcpId,
        result: message.result,
        error: message.error
      });
    }
  } else if (message.type === "pong") {
    log("Chrome ping OK");
  }
}

// ============================================================================
// Unix Socket Server for MCP
// ============================================================================

try {
  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH);
  }
} catch {}

const unixServer = createNetServer((socket) => {
  log("MCP server connected");
  mcpConnections.add(socket);
  
  let buffer = "";
  
  socket.on("data", (data) => {
    buffer += data.toString();
    
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          handleMcpMessage(socket, message);
        } catch (e) {
          log("Failed to parse MCP message:", e.message);
        }
      }
    }
  });
  
  socket.on("close", () => {
    log("MCP server disconnected");
    mcpConnections.delete(socket);
  });
  
  socket.on("error", (err) => {
    log("MCP socket error:", err.message);
    mcpConnections.delete(socket);
  });
});

unixServer.listen(SOCKET_PATH, () => {
  log(`Unix socket listening at ${SOCKET_PATH}`);
});

function sendToMcp(socket, message) {
  if (socket && !socket.destroyed) {
    socket.write(JSON.stringify(message) + "\n");
  }
}

function handleMcpMessage(socket, message) {
  log("From MCP:", message.type, message.tool || "");
  
  if (message.type === "tool_request") {
    if (!chromeConnection) {
      sendToMcp(socket, {
        type: "tool_response",
        id: message.id,
        error: { content: "Chrome extension not connected. Open Chrome and ensure the OpenCode extension is enabled." }
      });
      return;
    }
    
    const id = ++requestId;
    pendingRequests.set(id, { socket, mcpId: message.id });
    
    sendToChrome({
      type: "tool_request",
      id,
      tool: message.tool,
      args: message.args
    });
  }
}

// ============================================================================
// Health Check
// ============================================================================

setInterval(() => {
  if (chromeConnection) {
    sendToChrome({ type: "ping" });
  }
}, 30000);

// ============================================================================
// Graceful Shutdown
// ============================================================================

function shutdown() {
  log("Shutting down...");
  wss.close();
  unixServer.close();
  try { unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

log("Daemon started successfully");
