// POST /api/embed — turn text into a vector with a Nebius embedding model.
// Returns dimensions, a preview of the vector, the L2 norm, token usage and cost.

import { getClient, costFor, CATALOG, EMBED_MODEL } from "../../../lib/nebius";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const EMBED_IDS = new Set(CATALOG.filter((m) => m.modality === "embedding").map((m) => m.id));

export async function POST(req) {
  const client = getClient();
  if (!client) {
    return new Response(JSON.stringify({ error: "NEBIUS_API_KEY not set" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  let model = "";
  let text = "";
  try {
    const b = await req.json();
    model = b.model;
    text = b.text;
  } catch {}
  if (!EMBED_IDS.has(model)) model = EMBED_MODEL;
  text = String(text || "").trim();
  if (!text) {
    return new Response(JSON.stringify({ error: "no text" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await client.embeddings.create({ model, input: [text] });
    const vec = res?.data?.[0]?.embedding || [];
    if (!vec.length) {
      return Response.json({ ok: false, error: "embedding model returned no vector" }, { status: 502 });
    }
    const usage = res?.usage || {};
    const tokens = usage.total_tokens || usage.prompt_tokens || 0;
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return Response.json({
      ok: true,
      model,
      dims: vec.length,
      sample: vec.slice(0, 10),
      vector: vec, // full vector so the UI can show/copy every dimension
      norm,
      tokens,
      cost: costFor(model, { prompt_tokens: tokens, completion_tokens: 0 }),
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 502 });
  }
}
