import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import net from "net";
import { createAgentBackend, type AgentBackend } from "./agent-backend.js";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const { schema } = tool;

const BASE_DIR = join(homedir(), ".opencode-browser");
const SOCKET_PATH = join(BASE_DIR, "broker.sock");

mkdirSync(BASE_DIR, { recursive: true });

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(BASE_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

const BACKEND_MODE = (process.env.OPENCODE_BROWSER_BACKEND ?? process.env.OPENCODE_BROWSER_MODE ?? "extension")
  .toLowerCase()
  .trim();
const USE_AGENT_BACKEND = ["agent", "agent-browser", "agentbrowser"].includes(BACKEND_MODE);

let socket: net.Socket | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const agentBackend: AgentBackend | null = USE_AGENT_BACKEND ? createAgentBackend(sessionId) : null;

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  // Try to connect; if missing, try to start broker and retry.
  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {}
    }
  }

  if (!socket || socket.destroyed) {
    throw new Error(
      "Could not connect to local broker. Run `npx @different-ai/opencode-browser install` and ensure the extension is loaded."
    );
  }

  socket.setNoDelay(true);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    throw new Error("Tab claims are not supported with agent-browser backend");
  }
  return await brokerRequest(op, payload);
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      throw new Error("Agent backend unavailable: configuration failed to initialize");
    }
    return await agentBackend.requestTool(toolName, args);
  }
  return await brokerRequest("tool", { tool: toolName, args });
}

async function statusRequest(): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      return {
        backend: "agent-browser",
        connected: false,
        error: "Agent backend unavailable: configuration failed to initialize",
      };
    }
    return await agentBackend.status();
  }
  return await brokerRequest("status", {});
}

const plugin: Plugin = async (ctx) => {

  return {
    tool: {
      browser_debug: tool({
        description: "Debug plugin loading and connection status.",
        args: {},
        async execute(args, ctx) {
          if (ctx?.client?.app?.log) {
            await ctx.client.app.log({
              service: "opencode-browser",
              level: "info",
              message: "browser_debug called",
              extra: { sessionId, pid: process.pid },
            });
          }
          return JSON.stringify({
            loaded: true,
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentSession: agentBackend?.session ?? null,
            agentConnection: agentBackend?.connection ?? null,
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
            pluginVersion: getPackageVersion(),
            timestamp: new Date().toISOString(),
          });
        },
      }),

      browser_version: tool({
        description: "Return the installed @different-ai/opencode-browser plugin version.",
        args: {},
        async execute(args, ctx) {
          return JSON.stringify({
            name: "@different-ai/opencode-browser",
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
          });
        },
      }),

      browser_status: tool({
        description: "Check backend connection status and current tab claims.",
        args: {},
        async execute(args, ctx) {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description: "Claim a browser tab for this session",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }, ctx) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new browser tab",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }, ctx) {
          const data = await toolRequest("open_tab", { url, active });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }, ctx) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_click: tool({
        description: "Click an element on the page using a CSS selector",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Clicked ${selector}`);
        },
      }),

      browser_type: tool({
        description: "Type text into an input element",
        args: {
          selector: schema.string(),
          text: schema.string(),
          clear: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, clear, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Typed "${text}" into ${selector}`);
        },
      }),

      browser_select: tool({
        description: "Select an option in a native select element",
        args: {
          selector: schema.string(),
          value: schema.string().optional(),
          label: schema.string().optional(),
          optionIndex: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs });
          const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
          return toolResultText(data, `Selected ${summary} in ${selector}`);
        },
      }),

      browser_screenshot: tool({
        description: "Take a screenshot of the current page. Returns base64 image data URL.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("screenshot", { tabId });
          return toolResultText(data, "Screenshot failed");
        },
      }),

      browser_snapshot: tool({
        description: "Get an accessibility tree snapshot of the page.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("snapshot", { tabId });
          return toolResultText(data, "Snapshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: schema.string().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, x, y, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }, ctx) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_query: tool({
        description:
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
        args: {
          selector: schema.string().optional(),
          mode: schema.string().optional(),
          attribute: schema.string().optional(),
          property: schema.string().optional(),
          index: schema.number().optional(),
          limit: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          pattern: schema.string().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }, ctx) {
          const data = await toolRequest("query", {
            selector,
            mode,
            attribute,
            property,
            index,
            limit,
            timeoutMs,
            pollMs,
            pattern,
            flags,
            tabId,
          });
          return toolResultText(data, "Query failed");
        },
      }),
    },
  };
};

export default plugin;
