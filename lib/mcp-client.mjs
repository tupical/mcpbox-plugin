// Minimal MCP (Model Context Protocol) client over stdio JSON-RPC for ouroboros.
// Speaks line-delimited JSON (one message per newline) — confirmed via probe
// against `ouroboros mcp serve` (mcp@1.27.0). Does not pull the @modelcontextprotocol
// SDK to keep omo dependency-free.
//
// Lifecycle:
//   const client = new MCPClient();
//   await client.start("ouroboros", ["mcp", "serve"], { cwd, stderrLog });
//   await client.initialize();
//   const result = await client.callTool("ouroboros_interview", { initial_context });
//   await client.stop();
//
// `result` is the parsed `result.content[]` from MCP tool/call response — the
// caller deals with whatever shape ouroboros puts in there (usually a single
// TextContent whose `text` is JSON we then parse).

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const REQUEST_TIMEOUT_MS = 120_000;

export class MCPClient {
  constructor() {
    this._proc = null;
    this._buf = "";
    this._nextId = 1;
    this._pending = new Map();
    this._initialized = false;
    this._serverInfo = null;
    this._stderrStream = null;
    this._failure = null;
  }

  async start(cmd, args = [], { cwd = process.cwd(), stderrLog = null, env = process.env } = {}) {
    if (this._proc) throw new Error("MCPClient already started");
    const proc = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this._proc = proc;
    this._failure = null;

    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
      stream.on("error", (err) => this._onError(err));
    }

    if (stderrLog) {
      this._stderrStream = createWriteStream(stderrLog, { flags: "a" });
      this._stderrStream.on("error", () => {});
      proc.stderr.pipe(this._stderrStream);
    } else {
      proc.stderr.on("data", () => {}); // drain to avoid backpressure
    }

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this._onData(chunk));
    proc.on("exit", (code, signal) => this._onExit(proc, code, signal));
    proc.on("error", (err) => this._onError(err));
  }

  async initialize() {
    const result = await this._call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omo", version: "0.0.4" },
    });
    this._serverInfo = result.serverInfo ?? null;
    this._initialized = true;
    // Per spec, follow up with a one-way "initialized" notification.
    await this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  async callTool(name, args = {}) {
    if (!this._initialized) throw new Error("MCPClient: call initialize() first");
    const result = await this._call("tools/call", { name, arguments: args });
    return this._unwrapToolResult(result);
  }

  async listTools() {
    if (!this._initialized) throw new Error("MCPClient: call initialize() first");
    const result = await this._call("tools/list", {});
    return result.tools ?? [];
  }

  async stop() {
    if (this._stderrStream) this._stderrStream.end();
    if (!this._proc) return;
    const proc = this._proc;
    this._proc = null;
    try {
      proc.stdin.end();
    } catch { /* already closed */ }
    // Give server up to 2s for graceful shutdown, then SIGTERM.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch { /* gone */ }
        resolve();
      }, 2000);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this._failAll(new Error("MCPClient stopped"));
  }

  // --- internals -----------------------------------------------------------

  _call(method, params) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP ${method} timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: "2.0", id, method, params }).catch((err) => {
        const pending = this._pending.get(id);
        if (!pending) return;
        this._pending.delete(id);
        pending.reject(err);
      });
    });
  }

  _send(msg) {
    const proc = this._proc;
    if (this._failure) return Promise.reject(this._failure);
    if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded) {
      return Promise.reject(new Error("MCPClient: server not running"));
    }
    return new Promise((resolve, reject) => {
      proc.stdin.write(JSON.stringify(msg) + "\n", (err) => err ? reject(err) : resolve());
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Server printed non-JSON noise on stdout (rare with ouroboros, but
        // possible). Skip silently — the server's stderr captures structured
        // diagnostics already.
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
        err.data = msg.error.data;
        reject(err);
      } else {
        resolve(msg.result);
      }
    }
    // Otherwise: notification or unmatched response — drop it.
  }

  _onExit(proc, code, signal) {
    if (this._proc !== proc) return;
    this._proc = null;
    this._onError(new Error(`MCP server exited (code=${code}, signal=${signal})`));
  }

  _onError(err) {
    this._failure ??= err;
    this._failAll(this._failure);
  }

  _failAll(err) {
    for (const [, { reject }] of this._pending) reject(err);
    this._pending.clear();
  }

  // MCP tool/call results come as `{ content: [{type, text}, ...], isError? }`.
  // Most ouroboros tools return one TextContent whose `text` is JSON.
  // Returns: { isError, content (raw array), text (joined text), parsed (best-effort JSON) }.
  _unwrapToolResult(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.map((c) => c?.text ?? "").join("");
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); }
      catch { /* leave as text */ }
    }
    return {
      isError: Boolean(result?.isError),
      content,
      text,
      parsed,
    };
  }
}
