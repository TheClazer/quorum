// lib/nebius.js — the single source of truth for the fleet, pricing, and the client.
// Token COUNTS come live from the API `usage` field. Per-1M RATES are Nebius's
// published list prices (source: requesty.ai/models/nebius, June 2026). Nothing
// here is fabricated: real tokens x real list rates.

import OpenAI from "openai";
import fs from "fs";
import path from "path";

export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

// Where a user-provided key is stored (gitignored). Lets the app prompt for the key on
// first run and edit/remove it from Settings — no restart, no committing secrets.
const KEY_FILE = path.join(process.cwd(), ".nebius-key.local");

// The panel: five frontier open-weight models from FIVE distinct vendors, all
// INSTRUCT (guaranteed visible content — no thinking-model empty-output traps),
// running on ONE Nebius credit pool. This diversity is the whole point: a closed
// provider physically cannot give you Meta + Alibaba + DeepSeek + NVIDIA + MiniMax
// on one bill.
// Each provider's BEST model that reliably STREAMS content. (Qwen3.5-397B, Kimi-K2.6
// and GLM-5.2 are larger but are reasoning models that stream empty content — verified —
// so the streaming-reliable best per vendor is used instead.)
export const PANEL = [
  { id: "deepseek-ai/DeepSeek-V4-Pro",              vendor: "DeepSeek", label: "DeepSeek V4-Pro",     color: "#4f7cff" },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507",       vendor: "Alibaba",  label: "Qwen3 235B",          color: "#b06bff" },
  { id: "MiniMaxAI/MiniMax-M2.5",                   vendor: "MiniMax",  label: "MiniMax M2.5",        color: "#ff8a3d" },
  { id: "nvidia/Nemotron-3-Ultra-550b-a55b",        vendor: "NVIDIA",   label: "Nemotron 3 Ultra",    color: "#76b900" },
  { id: "meta-llama/Llama-3.3-70B-Instruct",        vendor: "Meta",     label: "Llama 3.3 70B",       color: "#00c2ff" },
];

// The adjudicator: reads all five answers, clusters them, scores agreement.
// Must reliably emit STRICT JSON clusters (verified) and be INDEPENDENT (not a panel
// member). gpt-oss-120b: strong, cheap ($0.15/$0.60), non-panel, clean JSON. The old
// judge DeepSeek-V3.2 was removed from the key 2026-06; its -fast variant returns
// reasoning prose instead of JSON, so it can't judge — gpt-oss-120b replaces it.
export const JUDGE_MODEL = "openai/gpt-oss-120b";

// The retriever's embedding model — also on Nebius, so RAG stays on one bill.
export const EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";

// CHAMPIONS — the single best callable model from each provider, one per vendor.
// Every one is VERIFIED to return content on this key (reasoning models stream empty
// but the chat route's non-stream + reasoning_content fallback recovers the answer).
// Defined below CATALOG (it references it). This is the "top model from every provider"
// list, surfaced directly in Chat mode.
const CHAMPION_IDS = [
  "deepseek-ai/DeepSeek-V4-Pro",          // DeepSeek
  "Qwen/Qwen3.5-397B-A17B",               // Alibaba (flagship reasoner)
  "moonshotai/Kimi-K2.6",                 // Moonshot
  "zai-org/GLM-5.2",                      // Z.ai
  "nvidia/Nemotron-3-Ultra-550b-a55b",    // NVIDIA
  "MiniMaxAI/MiniMax-M2.5",               // MiniMax
  "NousResearch/Hermes-4-405B",           // NousResearch
  "PrimeIntellect/INTELLECT-3",           // PrimeIntellect
  "openai/gpt-oss-120b",                  // OpenAI (open-weight)
  "meta-llama/Llama-3.3-70B-Instruct",    // Meta
  "google/gemma-3-27b-it",                // Google
];

// FULL catalog of everything THIS key can actually call (verified against GET /v1/models).
// Image (FLUX) and video (Dop) are NOT here — they 404 on this Token Factory key.
// modality: "text" (chat) | "vision" (primarily multimodal) | "embedding".
// vision: true  = EMPIRICALLY verified to accept image input (sent a green PNG, got "green").
//   This is a CAPABILITY flag, separate from modality: several top text models (Gemma 3,
//   Kimi K2.6/K2.5, Qwen3.5-397B, Cosmos3) chat AND see, so they're modality "text" + vision.
export const CATALOG = [
  // ---- text / chat ----
  { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4-Pro", vendor: "DeepSeek", modality: "text" },
  { id: "deepseek-ai/DeepSeek-V3.2-fast", label: "DeepSeek V3.2 (fast)", vendor: "DeepSeek", modality: "text" },
  { id: "Qwen/Qwen3.5-397B-A17B", label: "Qwen3.5 397B", vendor: "Alibaba", modality: "text", reasoning: true, vision: true },
  { id: "Qwen/Qwen3.5-397B-A17B-fast", label: "Qwen3.5 397B (fast)", vendor: "Alibaba", modality: "text", reasoning: true, vision: true },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", label: "Qwen3 235B Instruct", vendor: "Alibaba", modality: "text" },
  { id: "Qwen/Qwen3-235B-A22B-Thinking-2507-fast", label: "Qwen3 235B Thinking (fast)", vendor: "Alibaba", modality: "text", reasoning: true },
  { id: "Qwen/Qwen3-30B-A3B-Instruct-2507", label: "Qwen3 30B Instruct", vendor: "Alibaba", modality: "text" },
  { id: "Qwen/Qwen3-32B", label: "Qwen3 32B", vendor: "Alibaba", modality: "text" },
  { id: "Qwen/Qwen3-Next-80B-A3B-Thinking", label: "Qwen3-Next 80B Thinking", vendor: "Alibaba", modality: "text", reasoning: true },
  { id: "Qwen/Qwen3-Next-80B-A3B-Thinking-fast", label: "Qwen3-Next 80B Thinking (fast)", vendor: "Alibaba", modality: "text", reasoning: true },
  { id: "moonshotai/Kimi-K2.6", label: "Kimi K2.6", vendor: "Moonshot", modality: "text", reasoning: true, vision: true },
  { id: "moonshotai/Kimi-K2.5-fast", label: "Kimi K2.5 (fast)", vendor: "Moonshot", modality: "text", reasoning: true },
  { id: "zai-org/GLM-5.2", label: "GLM-5.2", vendor: "Z.ai", modality: "text", reasoning: true },
  { id: "zai-org/GLM-5.1", label: "GLM-5.1", vendor: "Z.ai", modality: "text", reasoning: true },
  { id: "MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5", vendor: "MiniMax", modality: "text" },
  { id: "MiniMaxAI/MiniMax-M2.5-fast", label: "MiniMax M2.5 (fast)", vendor: "MiniMax", modality: "text" },
  { id: "nvidia/Nemotron-3-Ultra-550b-a55b", label: "Nemotron 3 Ultra 550B", vendor: "NVIDIA", modality: "text" },
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", vendor: "NVIDIA", modality: "text" },
  { id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", label: "Nemotron 3 Nano 30B", vendor: "NVIDIA", modality: "text" },
  { id: "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1", label: "Nemotron Ultra 253B", vendor: "NVIDIA", modality: "text" },
  { id: "nvidia/Cosmos3-Super-Reasoner", label: "Cosmos3 Super-Reasoner", vendor: "NVIDIA", modality: "text", reasoning: true, vision: true },
  { id: "meta-llama/Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", vendor: "Meta", modality: "text" },
  { id: "google/gemma-3-27b-it", label: "Gemma 3 27B", vendor: "Google", modality: "text", vision: true },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", vendor: "OpenAI OSS", modality: "text" },
  { id: "openai/gpt-oss-120b-fast", label: "GPT-OSS 120B (fast)", vendor: "OpenAI OSS", modality: "text" },
  { id: "NousResearch/Hermes-4-405B", label: "Hermes 4 405B", vendor: "NousResearch", modality: "text" },
  { id: "NousResearch/Hermes-4-70B", label: "Hermes 4 70B", vendor: "NousResearch", modality: "text" },
  { id: "PrimeIntellect/INTELLECT-3", label: "INTELLECT-3", vendor: "PrimeIntellect", modality: "text" },
  // ---- vision (multimodal chat) ----
  { id: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen2.5-VL 72B", vendor: "Alibaba", modality: "vision", vision: true },
  { id: "openbmb/MiniCPM-V-4_5", label: "MiniCPM-V 4.5", vendor: "OpenBMB", modality: "vision", vision: true },
  { id: "nvidia/Nemotron-3-Nano-Omni", label: "Nemotron 3 Nano Omni", vendor: "NVIDIA", modality: "vision", vision: true },
  // ---- embedding ----
  { id: "Qwen/Qwen3-Embedding-8B", label: "Qwen3 Embedding 8B", vendor: "Alibaba", modality: "embedding" },
];

// Resolve the champion ids into full catalog entries (id, label, vendor, reasoning?).
export const CHAMPIONS = CHAMPION_IDS
  .map((id) => CATALOG.find((m) => m.id === id))
  .filter(Boolean)
  .map((m) => ({ id: m.id, label: m.label, vendor: m.vendor, reasoning: Boolean(m.reasoning) }));

// Models selectable in 1-on-1 Chat mode = the champions (top model per provider).
export const CHAT_MODELS = CHAMPIONS;

// Image-generation models (Token Factory prices list FLUX + SDXL). These are NOT in
// /v1/models — the /v1/images/generations endpoint exists on the key but the serverless
// image models may need (re)deploying (public serverless endpoints were deprecated 2026-06-22).
// $/image from the Token Factory price sheet.
export const IMAGE_MODELS = [
  { id: "black-forest-labs/flux-schnell", label: "FLUX.1 Schnell", vendor: "Black Forest Labs", perImage: 0.0013 },
  { id: "black-forest-labs/flux-dev", label: "FLUX.1 Dev", vendor: "Black Forest Labs", perImage: 0.007 },
  { id: "stability-ai/sdxl", label: "SDXL", vendor: "Stability AI", perImage: 0.007 },
];
export const IMAGE_IDS = new Set(IMAGE_MODELS.map((m) => m.id));

// Any chat-capable (text or vision) model id from the catalog.
export const CHAT_CAPABLE = new Set(CATALOG.filter((m) => m.modality !== "embedding").map((m) => m.id));

export function isPriced(id) {
  return Object.prototype.hasOwnProperty.call(PRICING, id);
}

// Dedicated-endpoint GPUs Nebius Token Factory rents by the hour. Prices ($/GPU-hour,
// eu-north1) transcribed from the user's own Prices page — authoritative for this account.
// You deploy a model onto one of these in the console (Inference → Model endpoints); the
// resulting endpoint is then callable through this same OpenAI-compatible API.
export const GPUS = [
  { id: "L40S", label: "NVIDIA L40S", perHour: 2.00, vram: "48 GB",  tier: "Entry",     good: "Cheapest. Perfect for image generation (FLUX/SDXL) and small–mid models." },
  { id: "H100", label: "NVIDIA H100", perHour: 4.05, vram: "80 GB",  tier: "Workhorse", good: "The standard for LLM inference and fine-tuning. Best all-rounder." },
  { id: "H200", label: "NVIDIA H200", perHour: 4.70, vram: "141 GB", tier: "Big-memory", good: "More VRAM than H100 — fit larger models without sharding." },
  { id: "B200", label: "NVIDIA B200", perHour: 7.40, vram: "180 GB", tier: "Flagship",   good: "Blackwell generation. Top-tier throughput for very large models." },
  { id: "B300", label: "NVIDIA B300", perHour: 8.10, vram: "288 GB", tier: "Max",        good: "Newest, largest. Maximum memory and performance for the biggest workloads." },
];

// Cost of running a GPU for N hours.
export function gpuCost(gpuId, hours) {
  const g = GPUS.find((x) => x.id === gpuId);
  if (!g) return 0;
  return g.perHour * Math.max(0, hours || 0);
}

// Nebius Token Factory list prices (USD per 1M tokens), eu-north1. Transcribed
// directly from the user's own Prices page (the authoritative source for THIS key).
// Every callable model is priced — the cost meter never shows "n/a".
export const PRICING = {
  // ---- DeepSeek ----
  "deepseek-ai/DeepSeek-V4-Pro":                 { in: 1.75, out: 3.50 },
  "deepseek-ai/DeepSeek-V3.2":                   { in: 0.30, out: 0.45 },
  "deepseek-ai/DeepSeek-V3.2-fast":              { in: 0.40, out: 2.00 },
  // ---- Alibaba (Qwen) ----
  "Qwen/Qwen3.5-397B-A17B":                      { in: 0.60, out: 3.60 },
  "Qwen/Qwen3.5-397B-A17B-fast":                 { in: 0.60, out: 3.60 },
  "Qwen/Qwen3-235B-A22B-Instruct-2507":          { in: 0.20, out: 0.60 },
  "Qwen/Qwen3-235B-A22B-Thinking-2507-fast":     { in: 0.50, out: 2.00 },
  "Qwen/Qwen3-30B-A3B-Instruct-2507":            { in: 0.10, out: 0.30 },
  "Qwen/Qwen3-32B":                              { in: 0.10, out: 0.30 },
  "Qwen/Qwen3-Next-80B-A3B-Thinking":            { in: 0.15, out: 1.20 },
  "Qwen/Qwen3-Next-80B-A3B-Thinking-fast":       { in: 0.15, out: 1.20 },
  "Qwen/Qwen2.5-VL-72B-Instruct":                { in: 0.25, out: 0.75 },
  "Qwen/Qwen3-Embedding-8B":                     { in: 0.01, out: 0.0 },
  // ---- Moonshot (Kimi) ----
  "moonshotai/Kimi-K2.6":                        { in: 0.95, out: 4.00 },
  "moonshotai/Kimi-K2.5":                        { in: 0.50, out: 2.50 },
  "moonshotai/Kimi-K2.5-fast":                   { in: 0.50, out: 2.50 },
  // ---- Z.ai (GLM) ----
  "zai-org/GLM-5.2":                             { in: 1.40, out: 4.40 },
  "zai-org/GLM-5.1":                             { in: 1.40, out: 4.40 },
  "zai-org/GLM-5":                               { in: 1.00, out: 3.20 },
  // ---- MiniMax ----
  "MiniMaxAI/MiniMax-M2.5":                      { in: 0.30, out: 1.20 },
  "MiniMaxAI/MiniMax-M2.5-fast":                 { in: 0.30, out: 1.20 },
  // ---- NVIDIA (Nemotron / Cosmos) ----
  "nvidia/Nemotron-3-Ultra-550b-a55b":           { in: 1.00, out: 3.00 },
  "nvidia/nemotron-3-super-120b-a12b":           { in: 0.30, out: 0.90 },
  "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B":       { in: 0.06, out: 0.24 },
  "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1":     { in: 0.60, out: 1.80 },
  "nvidia/Cosmos3-Super-Reasoner":               { in: 0.10, out: 0.30 },
  "nvidia/Nemotron-3-Nano-Omni":                 { in: 0.06, out: 0.24 },
  // ---- Meta (Llama) ----
  "meta-llama/Llama-3.3-70B-Instruct":           { in: 0.13, out: 0.40 },
  // ---- Google (Gemma) ----
  "google/gemma-3-27b-it":                       { in: 0.10, out: 0.30 },
  // ---- OpenAI (open-weight) ----
  "openai/gpt-oss-120b":                         { in: 0.15, out: 0.60 },
  "openai/gpt-oss-120b-fast":                    { in: 0.10, out: 0.50 },
  // ---- NousResearch (Hermes) ----
  "NousResearch/Hermes-4-405B":                  { in: 1.00, out: 3.00 },
  "NousResearch/Hermes-4-70B":                   { in: 0.13, out: 0.40 },
  // ---- PrimeIntellect ----
  "PrimeIntellect/INTELLECT-3":                  { in: 0.20, out: 1.10 },
  // ---- OpenBMB (vision) ----
  "openbmb/MiniCPM-V-4_5":                       { in: 0.658, out: 1.11 },
};

// Closed-frontier list prices for the savings comparison (USD per 1M tokens).
// Current published rates, June 2026 (sources in README).
export const BASELINES = {
  gpt: { label: "GPT-5.5", in: 5.0, out: 30 },
  gemini: { label: "Gemini 3.1 Pro", in: 2.0, out: 12 },
  opus: { label: "Claude Opus", in: 5.0, out: 25 },
};

// The active key: an env var wins (dev/CI), otherwise the user-saved runtime file.
export function getKey() {
  const env = process.env.NEBIUS_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    if (fs.existsSync(KEY_FILE)) {
      const k = fs.readFileSync(KEY_FILE, "utf8").trim();
      if (k) return k;
    }
  } catch {}
  return "";
}
// Where the active key comes from — drives the Settings UI ("env" can't be edited in-app).
export function keySource() {
  if (process.env.NEBIUS_API_KEY && process.env.NEBIUS_API_KEY.trim()) return "env";
  try { if (fs.existsSync(KEY_FILE) && fs.readFileSync(KEY_FILE, "utf8").trim()) return "file"; } catch {}
  return "none";
}
export function setKey(k) {
  fs.writeFileSync(KEY_FILE, String(k || "").trim(), "utf8");
}
export function clearKey() {
  try { fs.unlinkSync(KEY_FILE); } catch {}
}
export function hasKey() {
  return Boolean(getKey());
}

export function getClient() {
  const key = getKey();
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: NEBIUS_BASE_URL });
}

// Cost of one model call from its real usage object.
export function costFor(modelId, usage) {
  const pr = PRICING[modelId] || { in: 0, out: 0 };
  const pin = usage?.prompt_tokens || 0;
  const pout = usage?.completion_tokens || 0;
  return (pin * pr.in + pout * pr.out) / 1e6;
}

// Same token volume priced at a closed-frontier baseline.
export function baselineCost(inTok, outTok, baseline) {
  const b = BASELINES[baseline];
  return (inTok * b.in + outTok * b.out) / 1e6;
}
