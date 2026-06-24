// GET /api/models — live fleet validation against Nebius GET /v1/models.
// Powers the "N models online" badge and the kill-switch proof: no key => dark.

import { getClient, hasKey, PANEL, JUDGE_MODEL, CHAT_MODELS, CATALOG, IMAGE_MODELS, GPUS, isPriced } from "../../../lib/nebius";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!hasKey()) {
    return Response.json({ ok: false, hasKey: false, online: 0, panel: [] });
  }
  const client = getClient();
  try {
    const res = await client.models.list();
    const ids = new Set((res?.data || []).map((m) => m.id));
    const panel = PANEL.map((p) => ({
      label: p.label,
      vendor: p.vendor,
      color: p.color,
      online: ids.has(p.id),
    }));
    const chatModels = CHAT_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      reasoning: !!m.reasoning,
      online: ids.has(m.id),
    }));
    const catalog = CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      modality: m.modality,
      reasoning: !!m.reasoning,
      vision: !!m.vision,
      online: ids.has(m.id),
      priced: isPriced(m.id),
    }));
    return Response.json({
      ok: true,
      hasKey: true,
      online: ids.size,
      judgeOnline: ids.has(JUDGE_MODEL),
      panel,
      chatModels,
      catalog,
      imageModels: IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, vendor: m.vendor, perImage: m.perImage })),
      gpus: GPUS,
    });
  } catch (e) {
    return Response.json(
      { ok: false, hasKey: true, online: 0, panel: [], error: String(e?.message || e) },
      { status: 502 }
    );
  }
}
