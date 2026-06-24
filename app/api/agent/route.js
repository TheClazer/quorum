// POST /api/agent — agentic coding loop over a local workspace, on a Nebius model.
// Verified: all strong models (DeepSeek-V4-Pro, Kimi-K2.6, GLM-5.2, Qwen3.5…) emit
// proper tool_calls. The model plans, then reads/edits files and runs commands via tools;
// we execute each tool locally and feed results back until it produces a final answer.
// Streams NDJSON: {assistant|tool_call|tool_result|file_written|running|final|error|done}.

import { getClient, CHAT_CAPABLE, CHAT_MODELS } from "../../../lib/nebius";
import path from "path";
import { promises as fs } from "fs";
import { exec } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache"]);

function inside(root, p) {
  const r = path.resolve(root);
  const abs = path.resolve(root, p || ".");
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error("path escapes the workspace");
  return abs;
}
async function listDir(root, rel) {
  const abs = inside(root, rel || ".");
  const ents = await fs.readdir(abs, { withFileTypes: true });
  const lines = ents.filter((e) => !IGNORE.has(e.name))
    .map((e) => (e.isDirectory() ? "[dir] " : "      ") + (rel ? rel.replace(/\/$/, "") + "/" : "") + e.name);
  return lines.join("\n") || "(empty)";
}
async function readFileTool(root, p) {
  const buf = await fs.readFile(inside(root, p));
  return buf.length > 120000 ? buf.slice(0, 120000).toString("utf8") + "\n…(truncated)" : buf.toString("utf8");
}
async function writeFileTool(root, p, content) {
  const abs = inside(root, p);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, String(content ?? ""), "utf8");
  return `wrote ${p} (${String(content ?? "").length} chars)`;
}
function runCommand(root, cmd) {
  return new Promise((res) => {
    exec(cmd, { cwd: root, timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, so, se) => {
      let out = (so || "") + (se ? "\n[stderr]\n" + se : "");
      if (err && err.killed) out += "\n[timed out after 45s]";
      else if (err && typeof err.code === "number") out += `\n[exit ${err.code}]`;
      res(out.trim() || "(no output)");
    });
  });
}

const ALL_TOOLS = [
  { type: "function", function: { name: "list_dir", description: "List files and folders at a path inside the workspace.", parameters: { type: "object", properties: { path: { type: "string", description: "relative path; omit for root" } } } } },
  { type: "function", function: { name: "read_file", description: "Read a file's full contents.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file. Provide the FULL new file contents.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "run_command", description: "Run a shell command in the workspace (tests, build, git, etc.). 45s timeout.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

const SYS =
  "You are a precise coding agent working directly inside the user's local workspace. " +
  "Use the tools to explore the project, read relevant files, make minimal correct edits, and run commands to verify. " +
  "Always read a file before editing it, and when you write a file provide its COMPLETE new contents (not a diff). " +
  "Prefer small, targeted changes. When finished, give a short plain summary of what you changed and why.";

export async function POST(req) {
  const client = getClient();
  if (!client) return new Response(JSON.stringify({ error: "NEBIUS_API_KEY not set" }), { status: 400 });

  let b = {};
  try { b = await req.json(); } catch {}
  const root = b.root;
  let model = b.model;
  const allowRun = b.allowRun === true;
  const history = Array.isArray(b.messages) ? b.messages : [];
  if (!root) return new Response(JSON.stringify({ error: "no workspace" }), { status: 400 });
  if (!CHAT_CAPABLE.has(model)) model = CHAT_MODELS[0].id;
  const tools = allowRun ? ALL_TOOLS : ALL_TOOLS.filter((t) => t.function.name !== "run_command");

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const send = (o) => { try { ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch {} };
      const msgs = [{ role: "system", content: SYS + "\n\nWorkspace root: " + root }, ...history.map((m) => ({ role: m.role, content: m.content }))];
      try {
        for (let step = 0; step < 18; step++) {
          const c = await client.chat.completions.create({ model, temperature: 0.2, max_tokens: 2400, tools, tool_choice: "auto", messages: msgs });
          const m = c?.choices?.[0]?.message || {};
          msgs.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls });
          if (m.content && m.content.trim()) send({ type: "assistant", text: m.content });
          const calls = m.tool_calls || [];
          if (!calls.length) { send({ type: "final", text: m.content || "" }); break; }
          for (const call of calls) {
            let args = {};
            try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
            send({ type: "tool_call", name: call.function.name, args });
            let result = "";
            try {
              if (call.function.name === "list_dir") result = await listDir(root, args.path);
              else if (call.function.name === "read_file") result = await readFileTool(root, args.path);
              else if (call.function.name === "write_file") { result = await writeFileTool(root, args.path, args.content); send({ type: "file_written", path: args.path }); }
              else if (call.function.name === "run_command") {
                if (!allowRun) result = "(running commands is disabled — the user has not enabled it)";
                else { send({ type: "running", command: args.command }); result = await runCommand(root, args.command); }
              } else result = "unknown tool";
            } catch (e) { result = "ERROR: " + String(e?.message || e); }
            send({ type: "tool_result", name: call.function.name, result: result.slice(0, 4000) });
            msgs.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 8000) });
          }
          if (step === 17) send({ type: "final", text: "Stopped after 18 steps to be safe — send another message to continue." });
        }
      } catch (e) {
        send({ type: "error", message: String(e?.error?.message || e?.message || e) });
      }
      send({ type: "done" });
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
