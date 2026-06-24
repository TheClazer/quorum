// lib/rag.js — Nebius-native retrieval. Embeds the knowledge base with
// Qwen3-Embedding-8B (one bill), caches the index in-process, and retrieves the
// most relevant chunks by cosine similarity. This is what cures the stale-cutoff
// problem: fresh facts get injected into every panelist's prompt at inference time.

import fs from "fs";
import path from "path";
import { EMBED_MODEL } from "./nebius";

let INDEX = null; // { chunks:[{title,text}], vectors:[[...]], indexTokens }

// Split the markdown corpus into one chunk per "## Heading" section.
function parseCorpus(md) {
  return md
    .split(/^##\s+/m)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const nl = part.indexOf("\n");
      const title = (nl >= 0 ? part.slice(0, nl) : part).trim();
      const body = (nl >= 0 ? part.slice(nl + 1) : "").trim();
      return { title, text: `${title}. ${body}`.trim() };
    });
}

export function loadChunks() {
  const file = path.join(process.cwd(), "lib", "knowledge.md");
  return parseCorpus(fs.readFileSync(file, "utf8"));
}

async function embed(client, inputs) {
  const res = await client.embeddings.create({ model: EMBED_MODEL, input: inputs });
  return { vectors: res.data.map((d) => d.embedding), usage: res.usage };
}

function cosine(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// Build the corpus index once (cached for the life of the server process).
async function ensureIndex(client) {
  if (INDEX) return { ...INDEX, fresh: false };
  const chunks = loadChunks();
  const { vectors, usage } = await embed(client, chunks.map((c) => c.text));
  INDEX = { chunks, vectors, indexTokens: usage?.total_tokens || 0 };
  return { ...INDEX, fresh: true };
}

// Retrieve the top-k chunks for a question. embedTokens counts the query embed
// plus the one-time index build (only on the first grounded request).
export async function retrieve(client, question, k = 4) {
  const idx = await ensureIndex(client);
  const { vectors, usage } = await embed(client, [question]);
  const qv = vectors[0];
  const scored = idx.chunks
    .map((c, i) => ({ title: c.title, text: c.text, score: cosine(qv, idx.vectors[i]) }))
    .sort((a, b) => b.score - a.score);
  return {
    hits: scored.slice(0, k),
    embedTokens: (usage?.total_tokens || 0) + (idx.fresh ? idx.indexTokens : 0),
    chunkCount: idx.chunks.length,
  };
}
