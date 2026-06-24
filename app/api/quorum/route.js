// POST /api/quorum — convene the panel.
// Streams NDJSON events: per-model token deltas (5 columns live in parallel),
// then a judge verdict (clusters + confidence + dissent), then the real cost.

import {
  getClient,
  PANEL,
  JUDGE_MODEL,
  EMBED_MODEL,
  costFor,
  baselineCost,
} from "../../../lib/nebius";
import { retrieve } from "../../../lib/rag";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PANEL_SYS =
  "You are one independent member of an expert panel answering a user's question. " +
  "Give your own honest, direct answer in at most 110 words. Commit to a clear position — " +
  "if it's a yes/no or contested question, state your stance in the first sentence. " +
  "Do not hedge into a non-answer, do not mention other panelists. Plain prose, no markdown headers.";

const DEBATE_SYS =
  "You are one member of an expert panel now in its SECOND round. You have just read every other " +
  "member's answer. Be intellectually honest: if a peer's argument is genuinely stronger, revise your " +
  "position and say so; if not, hold firm and explain why their reasoning fails. State your FINAL stance " +
  "in the first sentence, then justify it in at most 80 words total. Plain prose, no markdown.";

function judgeSys(n) {
  return (
    `You are the impartial adjudicator of a panel of ${n} independent AI models that each answered the SAME question. ` +
    `Your job is NOT to answer the question yourself first — it is to measure where the panel agrees and disagrees, ` +
    `because disagreement is the signal a single model would hide. ` +
    `Cluster the ${n} answers by their core stance. Then output STRICT JSON ONLY (no prose, no code fence) with this shape:\n` +
    `{\n` +
    `  "verdict": "one or two sentence synthesis of the panel's best answer",\n` +
    `  "confidence": <integer 0-100, = how strongly the panel converges>,\n` +
    `  "agree_count": <integer, size of the largest agreeing cluster>,\n` +
    `  "total": ${n},\n` +
    `  "disagreement": <true if the panel is meaningfully split, else false>,\n` +
    `  "clusters": [ { "stance": "<=6 word label", "models": [<1-based model numbers>] } ],\n` +
    `  "dissent": "if split: what the minority claims and why it matters; else empty string"\n` +
    `}\n` +
    `Every model number 1..${n} must appear in exactly one cluster. confidence should be high (85-100) only when nearly all models agree.`
  );
}

function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  // tolerate stray prose / code fences around the object
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

function normalizeConsensus(raw, n) {
  const total = n;
  let clusters = Array.isArray(raw?.clusters) ? raw.clusters : [];
  clusters = clusters
    .map((c) => ({
      stance: String(c?.stance || "—").slice(0, 60),
      models: Array.isArray(c?.models) ? c.models.map(Number).filter((x) => x >= 1 && x <= n) : [],
    }))
    .filter((c) => c.models.length > 0);
  const agree =
    Number(raw?.agree_count) ||
    (clusters.length ? Math.max(...clusters.map((c) => c.models.length)) : total);
  let confidence = Number(raw?.confidence);
  if (!Number.isFinite(confidence)) confidence = Math.round((agree / total) * 100);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));
  return {
    verdict: String(raw?.verdict || "").trim(),
    confidence,
    agree_count: Math.max(1, Math.min(total, agree)),
    total,
    disagreement: Boolean(raw?.disagreement ?? agree < total),
    clusters,
    dissent: String(raw?.dissent || "").trim(),
  };
}

async function runJudge(client, question, results, signal) {
  const n = PANEL.length;
  const answers = results
    .map(
      (r, i) =>
        `Model ${i + 1} — ${PANEL[i].label}:\n${r.ok && r.text.trim() ? r.text.trim() : "[no usable answer]"}`
    )
    .join("\n\n");
  const messages = [
    { role: "system", content: judgeSys(n) },
    { role: "user", content: `QUESTION:\n${question}\n\nPANEL ANSWERS:\n${answers}\n\nReturn the JSON now.` },
  ];
  // Try the primary judge, then independent fallbacks. A model can be REMOVED from the
  // key (404) OR return prose instead of JSON (empty clusters) — both must fall through,
  // so the verdict can never silently break again. All three are verified clean-JSON,
  // non-panel judges.
  const candidates = [JUDGE_MODEL, "NousResearch/Hermes-4-405B", "nvidia/nemotron-3-super-120b-a12b"]
    .filter((m, i, a) => a.indexOf(m) === i);
  let parsed = null;
  let usage = null;
  let usedModel = JUDGE_MODEL;
  for (const jm of candidates) {
    let completion = null;
    try {
      try {
        completion = await client.chat.completions.create({ model: jm, temperature: 0, max_tokens: 700, response_format: { type: "json_object" }, messages }, { signal });
      } catch {
        completion = await client.chat.completions.create({ model: jm, temperature: 0, max_tokens: 700, messages }, { signal });
      }
    } catch {
      if (signal?.aborted) throw new Error("aborted");
      continue; // this judge model is unavailable (e.g. 404) — try the next
    }
    const content = completion?.choices?.[0]?.message?.content || "";
    if (!content.trim()) continue;
    const p = normalizeConsensus(safeParseJson(content) || {}, n);
    if (p.clusters.length) { parsed = p; usage = completion?.usage || null; usedModel = jm; break; } // good verdict — done
    if (!parsed) { parsed = p; usage = completion?.usage || null; usedModel = jm; } // best-effort, but keep trying for real clusters
  }
  if (!parsed) throw new Error("no judge model is currently available");
  return { parsed, usage, model: usedModel };
}

export async function POST(req) {
  const client = getClient();
  if (!client) {
    return new Response(JSON.stringify({ error: "NEBIUS_API_KEY not set" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  let question = "";
  let rounds = 1;
  let grounded = false;
  let history = [];
  try {
    const body = await req.json();
    question = body.question;
    rounds = body.rounds;
    grounded = body.grounded;
    history = Array.isArray(body.history) ? body.history : [];
  } catch {}
  grounded = Boolean(grounded);
  question = String(question || "").trim();

  // Prior turns of THIS conversation, so the council continues the same debate.
  const convoCtx =
    history.length > 0
      ? "CONVERSATION SO FAR (continue this same debate; the user is following up):\n" +
        history
          .slice(-6)
          .map((h, i) => `Turn ${i + 1} — User: "${String(h?.question || "").slice(0, 300)}"\n  Panel verdict: ${String(h?.verdict || "").slice(0, 400)}`)
          .join("\n") +
        "\n\n---\n\n"
      : "";
  // Number of debate rounds the user asked for. Each round = one council pass where
  // every model reads the others' latest answers and replies. Capped for demo safety.
  rounds = Math.max(0, Math.min(3, Number.isFinite(+rounds) ? Math.floor(+rounds) : 1));
  if (!question) {
    return new Response(JSON.stringify({ error: "empty question" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // When the user hits Stop, the browser aborts the fetch and the connection drops.
  // Tie a controller to that so we actually CANCEL the in-flight Nebius calls (panel,
  // debate rounds, judge) instead of billing them to completion in the background.
  const ac = new AbortController();
  try { req.signal?.addEventListener("abort", () => ac.abort(), { once: true }); } catch {}

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          ac.abort(); // client is gone — stop spending tokens
        }
      };

      try {
      send({ type: "start", panel: PANEL.map((p) => ({ label: p.label, vendor: p.vendor, color: p.color })) });

      // ── RAG: retrieve current facts and ground every panelist (Nebius embeddings) ──
      let groundCtx = "";
      let embedTokens = 0;
      if (grounded) {
        send({ type: "retrieving" });
        try {
          // Retrieve on the whole topic — the first question anchors it, the latest
          // resolves vague pronouns ("it") — not just the (often vague) follow-up.
          const retrievalQuery = [history[0]?.question, history[history.length - 1]?.question, question]
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join("\n");
          const { hits, embedTokens: et, chunkCount } = await retrieve(client, retrievalQuery, 4);
          embedTokens = et;
          groundCtx =
            "CURRENT KNOWLEDGE BASE — retrieved for this question and MORE RECENT than your training data. " +
            "Treat these facts as authoritative and use them in your answer:\n\n" +
            hits.map((h, i) => `[${i + 1}] ${h.text}`).join("\n\n") +
            "\n\n---\n\n";
          send({
            type: "sources",
            sources: hits.map((h) => ({ title: h.title, score: Math.round(h.score * 100) / 100 })),
            chunkCount,
          });
        } catch (e) {
          send({ type: "sourcesError", message: String(e?.message || e) });
        }
      }

      const results = new Array(PANEL.length);

      // Fan out all five panelists CONCURRENTLY — one credit pool, five vendors.
      await Promise.all(
        PANEL.map(async (p, i) => {
          try {
            const completion = await client.chat.completions.create({
              model: p.id,
              temperature: 0.7,
              max_tokens: 320,
              stream: true,
              stream_options: { include_usage: true },
              messages: [
                { role: "system", content: PANEL_SYS },
                { role: "user", content: convoCtx + groundCtx + question },
              ],
            }, { signal: ac.signal });
            let text = "";
            let usage = null;
            for await (const chunk of completion) {
              const delta = chunk?.choices?.[0]?.delta?.content || "";
              if (delta) {
                text += delta;
                send({ type: "delta", i, text: delta });
              }
              if (chunk?.usage) usage = chunk.usage;
            }
            results[i] = { i, text, usage, ok: text.trim().length > 0 };
            send({ type: "panelDone", i, usage, chars: text.length });
          } catch (e) {
            results[i] = { i, text: "", usage: null, ok: false, error: String(e?.message || e) };
            send({ type: "panelError", i, message: String(e?.message || e) });
          }
        })
      );

      // A running ledger of every billable call (real usage), across all rounds.
      const ledger = [];
      if (grounded && embedTokens) ledger.push({ id: EMBED_MODEL, usage: { prompt_tokens: embedTokens, completion_tokens: 0 } });
      for (const r of results) if (r?.usage) ledger.push({ id: PANEL[r.i].id, usage: r.usage });

      // Adjudicate round 1.
      send({ type: "judging" });
      let consensus = null;
      try {
        const judged = await runJudge(client, question, results, ac.signal);
        consensus = judged.parsed;
        if (judged.usage) ledger.push({ id: judged.model || JUDGE_MODEL, usage: judged.usage });
        send({ type: "consensus", ...consensus });
      } catch (e) {
        send({ type: "judgeError", message: String(e?.message || e) });
      }

      // Run N DEBATE rounds — a council that reads each other and revises, N from the user.
      // Each round, every model sees the panel's LATEST answers (from the prior round).
      let latest = results;
      for (let r = 1; r <= rounds; r++) {
        if (ac.signal.aborted) break; // user hit Stop — don't start another round
        send({ type: "debateStart", round: r, total: rounds });
        const digest = latest
          .map((x, i) => `${PANEL[i].label}: ${x?.ok ? x.text.trim().slice(0, 380) : "[no answer]"}`)
          .join("\n\n");
        const next = new Array(PANEL.length);
        await Promise.all(
          PANEL.map(async (p, i) => {
            const prev = latest[i];
            if (!prev?.ok) {
              next[i] = prev;
              return;
            }
            try {
              const completion = await client.chat.completions.create({
                model: p.id,
                temperature: 0.6,
                max_tokens: 340,
                stream: true,
                stream_options: { include_usage: true },
                messages: [
                  { role: "system", content: DEBATE_SYS },
                  {
                    role: "user",
                    content: `${convoCtx}${groundCtx}QUESTION:\n${question}\n\nThe full panel's latest answers:\n${digest}\n\nYOUR latest answer:\n${prev.text.trim()}\n\nThis is debate round ${r} of ${rounds}. After weighing your peers, give your position for this round.`,
                  },
                ],
              }, { signal: ac.signal });
              let text = "";
              let usage = null;
              for await (const chunk of completion) {
                const d = chunk?.choices?.[0]?.delta?.content || "";
                if (d) {
                  text += d;
                  send({ type: "delta2", i, round: r, text: d });
                }
                if (chunk?.usage) usage = chunk.usage;
              }
              // If a model returns empty, keep its previous answer so the judge never
              // sees a blank and the column never goes empty.
              const finalText = text.trim() ? text : prev.text;
              next[i] = { i, text: finalText, usage, ok: true };
              if (usage) ledger.push({ id: p.id, usage });
              send({ type: "panelDone2", i, round: r, usage });
            } catch (e) {
              next[i] = prev;
              send({ type: "panelError2", i, round: r, message: String(e?.message || e) });
            }
          })
        );
        latest = next;
      }

      // Final adjudication after all debate rounds.
      if (rounds > 0 && !ac.signal.aborted) {
        send({ type: "judging2" });
        try {
          const judged2 = await runJudge(client, question, latest, ac.signal);
          if (judged2.usage) ledger.push({ id: judged2.model || JUDGE_MODEL, usage: judged2.usage });
          send({ type: "consensus2", ...judged2.parsed, roundsRun: rounds });
        } catch (e) {
          send({ type: "judgeError2", message: String(e?.message || e) });
        }
      }

      // Real cost from real usage across every round.
      let inTok = 0,
        outTok = 0,
        nebiusUsd = 0;
      for (const item of ledger) {
        nebiusUsd += costFor(item.id, item.usage);
        inTok += item.usage.prompt_tokens || 0;
        outTok += item.usage.completion_tokens || 0;
      }
      send({
        type: "cost",
        nebiusUsd,
        gptUsd: baselineCost(inTok, outTok, "gpt"),
        geminiUsd: baselineCost(inTok, outTok, "gemini"),
        opusUsd: baselineCost(inTok, outTok, "opus"),
        inTok,
        outTok,
        totalTok: inTok + outTok,
        rounds: 1 + rounds,
        grounded,
        embedTokens,
      });

      } catch (e) {
        send({ type: "fatal", message: String(e?.message || e) });
      } finally {
        send({ type: "done", aborted: ac.signal.aborted });
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
