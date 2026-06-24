// POST /api/chat — 1-on-1 chat with a single chosen model.
// Streams NDJSON: {sources?}, {delta...}, {thinking?}, {cost}, {done}.
// Sends the FULL conversation each turn, optional RAG grounding, and falls back to
// a non-streamed call if a reasoning model (Kimi/GLM) streams empty content.

import { getClient, costFor, baselineCost, CHAT_MODELS, CHAT_CAPABLE, EMBED_MODEL, isPriced, CATALOG } from "../../../lib/nebius";
import { retrieve } from "../../../lib/rag";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHAT_SYS =
  "You are a sharp, helpful assistant. Answer the user's messages directly and conversationally, " +
  "keeping the full conversation in mind. If a KNOWLEDGE BASE block is provided, treat those facts as " +
  "authoritative and more recent than your training data.";

// Open-weight models are trained on data that predates their own release, so they
// misidentify themselves (we've seen one name a different vendor's model entirely, and
// another claim an older version). We know the TRUE model from the API id, so we tell it.
function identityFor(modelId) {
  const m = CATALOG.find((x) => x.id === modelId);
  if (!m) return "";
  return (
    `\n\nYOUR IDENTITY (authoritative — this overrides anything you think you know from training): ` +
    `you are ${m.label}${m.vendor ? " by " + m.vendor : ""} (API id "${modelId}"), served on-demand ` +
    `via Nebius Token Factory. If asked which model you are, answer with exactly this identity. ` +
    `Open-weight models are usually trained on data from before their own release, so you may not ` +
    `recognize your own version or know your real training cutoff — do NOT claim to be an earlier ` +
    `version, a different company's model, or invent a cutoff date; if unsure about your cutoff, say so.`
  );
}

export async function POST(req) {
  const client = getClient();
  if (!client) {
    return new Response(JSON.stringify({ error: "NEBIUS_API_KEY not set" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  let model = "";
  let messages = [];
  let grounded = false;
  let custom = false; // a user-deployed dedicated-endpoint id (not in our catalog)
  try {
    const b = await req.json();
    model = b.model;
    messages = Array.isArray(b.messages) ? b.messages : [];
    grounded = Boolean(b.grounded);
    custom = Boolean(b.custom);
  } catch {}

  // For catalog models we validate/fallback. For a custom deployed endpoint we trust the
  // id as-is (the Nebius API returns a clear error if it isn't actually deployed).
  if (!custom && !CHAT_CAPABLE.has(model)) model = CHAT_MODELS[0].id;
  if (custom && (!model || typeof model !== "string")) model = CHAT_MODELS[0].id;
  // keep only valid chat turns, full history. content can be a string OR a
  // multimodal array (text + image_url) for vision models.
  messages = messages
    .filter((m) => {
      if (!m || (m.role !== "user" && m.role !== "assistant")) return false;
      if (typeof m.content === "string") return m.content.trim().length > 0;
      return Array.isArray(m.content) && m.content.length > 0;
    })
    .map((m) => ({ role: m.role, content: m.content }));
  if (!messages.length) {
    return new Response(JSON.stringify({ error: "no messages" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {}
      };

      // ── RAG over the recent user turns (full-context query) ──
      let groundCtx = "";
      let embedTokens = 0;
      if (grounded) {
        send({ type: "retrieving" });
        try {
          const textOf = (c) => (typeof c === "string" ? c : (Array.isArray(c) ? c.find((p) => p.type === "text")?.text || "" : ""));
          const userTurns = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
          const q = [userTurns[0], ...userTurns.slice(-2)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("\n");
          const { hits, embedTokens: et } = await retrieve(client, q, 4);
          embedTokens = et;
          groundCtx =
            "KNOWLEDGE BASE — retrieved for this conversation, treat as authoritative and current:\n\n" +
            hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n") +
            "\n\n---\n\n";
          send({ type: "sources", sources: hits.map((h) => ({ title: h.title, score: Math.round(h.score * 100) / 100 })) });
        } catch (e) {
          send({ type: "sourcesError", message: String(e?.message || e) });
        }
      }

      // build messages: system + full history; inject grounding into the last user turn
      const msgs = messages.map((m) => ({ ...m }));
      if (groundCtx) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            const c = msgs[i].content;
            msgs[i] = {
              role: "user",
              content: typeof c === "string" ? groundCtx + c : [{ type: "text", text: groundCtx }, ...c],
            };
            break;
          }
        }
      }
      const chatMessages = [{ role: "system", content: CHAT_SYS + identityFor(model) }, ...msgs];

      let text = "";
      let promptT = 0;
      let compT = 0;
      try {
        const completion = await client.chat.completions.create({
          model,
          temperature: 0.7,
          max_tokens: 1200,
          stream: true,
          stream_options: { include_usage: true },
          messages: chatMessages,
        });
        let reasoningText = "";
        for await (const chunk of completion) {
          const delta = chunk?.choices?.[0]?.delta || {};
          const d = delta.content || "";
          if (d) {
            text += d;
            send({ type: "delta", text: d });
          }
          if (delta.reasoning_content) reasoningText += delta.reasoning_content;
          if (chunk?.usage) {
            promptT += chunk.usage.prompt_tokens || 0;
            compT += chunk.usage.completion_tokens || 0;
          }
        }
        // Some reasoning models put the answer in reasoning_content with empty content.
        if (!text.trim() && reasoningText.trim()) {
          text = reasoningText;
          send({ type: "delta", text: reasoningText });
        }

        // Reasoning models (Kimi/GLM) can stream empty content — retry non-streamed
        // with a larger budget so the answer comes back.
        if (!text.trim()) {
          send({ type: "thinking" });
          const c2 = await client.chat.completions.create({
            model,
            temperature: 0.7,
            max_tokens: 2400,
            messages: chatMessages,
          });
          const m = c2?.choices?.[0]?.message;
          const content = m?.content && m.content.trim() ? m.content : m?.reasoning_content || "";
          if (content) {
            text = content;
            send({ type: "delta", text: content });
          }
          if (c2?.usage) {
            promptT += c2.usage.prompt_tokens || 0;
            compT += c2.usage.completion_tokens || 0;
          }
        }
      } catch (e) {
        send({ type: "error", message: String(e?.message || e) });
      }

      // Both the streamed and non-streamed attempts returned nothing — surface it
      // instead of letting the client persist a silent "(no response)".
      if (!text.trim()) {
        send({ type: "error", message: "the model returned no content — try another model or rephrase" });
      }

      // Real cost from real usage (chat model + any embedding tokens).
      let inTok = promptT;
      let nebiusUsd = costFor(model, { prompt_tokens: promptT, completion_tokens: compT });
      if (grounded && embedTokens) {
        nebiusUsd += costFor(EMBED_MODEL, { prompt_tokens: embedTokens, completion_tokens: 0 });
        inTok += embedTokens;
      }
      send({
        type: "cost",
        model,
        nebiusUsd,
        gptUsd: baselineCost(inTok, compT, "gpt"),
        geminiUsd: baselineCost(inTok, compT, "gemini"),
        opusUsd: baselineCost(inTok, compT, "opus"),
        inTok,
        outTok: compT,
        totalTok: inTok + compT,
        grounded,
        priced: isPriced(model),
      });
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
    },
  });
}
