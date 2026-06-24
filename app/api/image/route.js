// POST /api/image — text-to-image via Nebius /v1/images/generations (OpenAI-compatible).
// Returns a base64 PNG, or a clear error (e.g. "model not found" when the image model
// isn't deployed on the key). Image models are billed per-image, not per-token.

import { getClient, IMAGE_MODELS, IMAGE_IDS } from "../../../lib/nebius";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export async function POST(req) {
  const client = getClient();
  if (!client) {
    return new Response(JSON.stringify({ error: "NEBIUS_API_KEY not set" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  let model = "";
  let prompt = "";
  try {
    const b = await req.json();
    model = b.model;
    prompt = b.prompt;
  } catch {}
  if (!IMAGE_IDS.has(model)) model = IMAGE_MODELS[0].id;
  prompt = String(prompt || "").trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: "no prompt" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const res = await client.images.generate({
      model,
      prompt,
      response_format: "b64_json",
      n: 1,
    });
    const b64 = res?.data?.[0]?.b64_json || null;
    const url = res?.data?.[0]?.url || null;
    if (!b64 && !url) {
      return Response.json({ ok: false, error: "image model returned no image" }, { status: 502 });
    }
    const perImage = IMAGE_MODELS.find((m) => m.id === model)?.perImage ?? null;
    return Response.json({ ok: true, model, b64, url, cost: perImage });
  } catch (e) {
    const status = e?.status || 502;
    let msg = e?.error?.message || e?.message || String(e);
    if (status === 404) {
      msg = `"${model}" is not deployed on your key (404). Public serverless image endpoints were deprecated 2026-06-22 — deploy a FLUX/SDXL model under Inference → Model endpoints in your Nebius dashboard to enable image generation.`;
    }
    return Response.json({ ok: false, error: msg, status }, { status: 200 });
  }
}
