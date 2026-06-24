// POST /api/fs — local filesystem ops for the Code workspace, sandboxed to a root.
// Quorum runs locally, so the Node server can read/write the user's files. Every path
// is resolved and checked to stay INSIDE the chosen workspace root (no traversal out).
//   action "list"  {root}            -> file tree (ignores node_modules/.git/etc.)
//   action "read"  {root, path}      -> file contents
//   action "write" {root, path, content}

import path from "path";
import { promises as fs } from "fs";

export const dynamic = "force-dynamic";

const IGNORE = new Set(["node_modules", ".git", ".next", "dist", "build", ".cache", ".turbo", "out"]);

function inside(root, p) {
  const r = path.resolve(root);
  const abs = path.resolve(root, p || ".");
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error("path escapes the workspace");
  return abs;
}

async function tree(root, rel, depth, out) {
  if (depth > 7 || out.length > 4000) return out;
  const abs = inside(root, rel);
  let ents;
  try { ents = await fs.readdir(abs, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
  for (const e of ents) {
    if (IGNORE.has(e.name)) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) { out.push({ type: "dir", path: r, depth }); await tree(root, r, depth + 1, out); }
    else out.push({ type: "file", path: r, depth });
  }
  return out;
}

export async function POST(req) {
  let b = {};
  try { b = await req.json(); } catch {}
  const { action, root } = b;
  if (!root) return Response.json({ ok: false, error: "no workspace folder set" });
  try {
    const st = await fs.stat(root).catch(() => null);
    if (!st || !st.isDirectory()) return Response.json({ ok: false, error: "folder not found: " + root });

    if (action === "list") {
      const files = await tree(root, "", 0, []);
      return Response.json({ ok: true, files });
    }
    if (action === "read") {
      const abs = inside(root, b.path);
      const buf = await fs.readFile(abs);
      const cap = 400 * 1024;
      return Response.json({ ok: true, path: b.path, content: buf.slice(0, cap).toString("utf8"), truncated: buf.length > cap });
    }
    if (action === "write") {
      const abs = inside(root, b.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(b.content ?? ""), "utf8");
      return Response.json({ ok: true, path: b.path });
    }
    return Response.json({ ok: false, error: "unknown action" });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e) });
  }
}
