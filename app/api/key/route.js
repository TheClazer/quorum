// /api/key — manage the Nebius API key at runtime (first-run setup + Settings).
//   GET    -> { hasKey, source: "env"|"file"|"none", masked }
//   POST {key} -> validates the key against Nebius, then saves it (no restart needed)
//   DELETE -> removes the saved key
// The key lives in a gitignored file server-side; it is never sent back to the browser
// in full (only a masked preview) and never committed.

import { keySource, getKey, setKey, clearKey, NEBIUS_BASE_URL } from "../../../lib/nebius";
import OpenAI from "openai";

export const dynamic = "force-dynamic";

function masked(k) {
  if (!k) return "";
  return k.length <= 10 ? "••••" : k.slice(0, 5) + "…" + k.slice(-4);
}
const envLocked = () => Boolean(process.env.NEBIUS_API_KEY && process.env.NEBIUS_API_KEY.trim());

export async function GET() {
  const source = keySource();
  return Response.json({ hasKey: source !== "none", source, masked: masked(getKey()), envLocked: envLocked() });
}

export async function POST(req) {
  if (envLocked()) return Response.json({ ok: false, error: "A key is set via the environment (.env.local) — edit it there." });
  let key = "";
  try { ({ key } = await req.json()); } catch {}
  key = String(key || "").trim();
  if (!key) return Response.json({ ok: false, error: "Paste your Nebius API key." });
  // Validate it actually works before saving, so a typo can't silently break everything.
  try {
    const c = new OpenAI({ apiKey: key, baseURL: NEBIUS_BASE_URL });
    await c.models.list();
  } catch (e) {
    const code = e?.status ? ` (${e.status})` : "";
    return Response.json({ ok: false, error: `That key didn't authenticate with Nebius${code}. Double-check it and try again.` });
  }
  setKey(key);
  return Response.json({ ok: true, masked: masked(key) });
}

export async function DELETE() {
  if (envLocked()) return Response.json({ ok: false, error: "Key is set via the environment — remove it from .env.local." });
  clearKey();
  return Response.json({ ok: true });
}
