"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const EXAMPLES = [
  "Is a hot dog a sandwich?",
  "Will AGI arrive before 2030?",
  "Is Opus 4.8 the best LLM available right now?",
];
const STORE_KEY = "quorum.conversations.v1";
const ENDPOINTS_KEY = "quorum.endpoints.v1"; // user's deployed dedicated-GPU endpoints

// GPUs Nebius rents by the hour (mirrors lib/nebius.js GPUS; used until /api/models loads).
const FALLBACK_GPUS = [
  { id: "L40S", label: "NVIDIA L40S", perHour: 2.0, vram: "48 GB", tier: "Entry", good: "Cheapest. Perfect for image generation (FLUX/SDXL) and small–mid models." },
  { id: "H100", label: "NVIDIA H100", perHour: 4.05, vram: "80 GB", tier: "Workhorse", good: "The standard for LLM inference and fine-tuning. Best all-rounder." },
  { id: "H200", label: "NVIDIA H200", perHour: 4.7, vram: "141 GB", tier: "Big-memory", good: "More VRAM than H100 — fit larger models without sharding." },
  { id: "B200", label: "NVIDIA B200", perHour: 7.4, vram: "180 GB", tier: "Flagship", good: "Blackwell generation. Top-tier throughput for very large models." },
  { id: "B300", label: "NVIDIA B300", perHour: 8.1, vram: "288 GB", tier: "Max", good: "Newest, largest. Maximum memory and performance for the biggest workloads." },
];

// Base models you can fine-tune (train) on your key. per1m = approx $/1M training tokens
// at 8–32K context (from the Prices sheet; rises at longer context). Llama-3.3-70B and
// Qwen3-14B are empirically verified to accept jobs; the rest have FT price rows on the sheet.
const FT_MODELS = [
  { id: "Qwen/Qwen3-14B", label: "Qwen3 14B", per1m: 0.4 },
  { id: "Qwen/Qwen2.5-7B-Instruct", label: "Qwen2.5 7B Instruct", per1m: 0.4 },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", per1m: 2.0 },
  { id: "meta-llama/Llama-3.3-70B-Instruct", label: "Llama 3.3 70B Instruct", per1m: 2.8 },
  { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B Instruct", per1m: 2.8 },
];

// A tiny ready-to-run training set (chat format) so the user can try training immediately.
const FT_SAMPLE = [
  { messages: [{ role: "user", content: "What is Quorum?" }, { role: "assistant", content: "Quorum is a Nebius-powered panel that runs many open models at once and shows where they agree and disagree." }] },
  { messages: [{ role: "user", content: "Who runs the models?" }, { role: "assistant", content: "Every model runs on Nebius Token Factory — one API, one bill, no model lock-in." }] },
  { messages: [{ role: "user", content: "Say the motto." }, { role: "assistant", content: "Many minds, one bill." }] },
].map((o) => JSON.stringify(o)).join("\n");

// Champions — the top model from every provider (one per vendor). Mirrors
// lib/nebius.js CHAMPIONS; used until /api/models resolves the live list.
const FALLBACK_CHAT_MODELS = [
  { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4-Pro", vendor: "DeepSeek" },
  { id: "Qwen/Qwen3.5-397B-A17B", label: "Qwen3.5 397B", vendor: "Alibaba", reasoning: true },
  { id: "moonshotai/Kimi-K2.6", label: "Kimi K2.6", vendor: "Moonshot", reasoning: true },
  { id: "zai-org/GLM-5.2", label: "GLM-5.2", vendor: "Z.ai", reasoning: true },
  { id: "nvidia/Nemotron-3-Ultra-550b-a55b", label: "Nemotron 3 Ultra", vendor: "NVIDIA" },
  { id: "MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5", vendor: "MiniMax" },
  { id: "NousResearch/Hermes-4-405B", label: "Hermes 4 405B", vendor: "NousResearch" },
  { id: "PrimeIntellect/INTELLECT-3", label: "INTELLECT-3", vendor: "PrimeIntellect" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", vendor: "OpenAI OSS" },
  { id: "meta-llama/Llama-3.3-70B-Instruct", label: "Llama 3.3 70B", vendor: "Meta" },
  { id: "google/gemma-3-27b-it", label: "Gemma 3 27B", vendor: "Google" },
];

const CATEGORIES = [
  { key: "text", label: "Text", desc: "Chat one-on-one with any text model on your key — full conversation memory, markdown answers, and optional knowledge-base grounding." },
  { key: "vision", label: "Vision", desc: "Models that SEE images (8 on your key, each verified by sending it a colored image). Attach or paste one and ask — describe, OCR, analyze, compare. Includes flagships that also chat: Gemma 3, Kimi K2.6, Qwen3.5 397B, Cosmos3. They read images, not video (every model returns “does not support video input”), and they don't generate images (image-gen isn't deployed on this key)." },
  { key: "embedding", label: "Embedding", desc: "Turn any text into a high-dimensional vector. Embeddings are the math behind semantic search and the grounding used in Debate mode." },
];

function newId() {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Composer key handling: Enter sends, Shift+Enter inserts a newline.
// (The textarea auto-sizes to its content via CSS `field-sizing: content`.)
function composerKey(e, send) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function computeVerdictView(consensus) {
  const map = {};
  if (consensus?.clusters?.length) {
    const ordered = [...consensus.clusters].sort((a, b) => b.models.length - a.models.length);
    const majIds = new Set(ordered[0].models);
    consensus.clusters.forEach((c) =>
      c.models.forEach((m) => {
        map[m - 1] = { kind: majIds.has(m) ? "maj" : "min", stance: c.stance };
      })
    );
  }
  return map;
}

export default function Home() {
  const [fleet, setFleet] = useState(null);
  const [keyInfo, setKeyInfo] = useState(null); // { hasKey, source, masked, envLocked }
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState("debate"); // debate | chat | other | gpu
  const [endpoints, setEndpoints] = useState([]); // user's deployed dedicated-GPU endpoints
  const [grounded, setGrounded] = useState(true);

  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [expanded, setExpanded] = useState(null);
  const threadRef = useRef(null);
  const abortRef = useRef(null);

  // debate
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [rounds, setRounds] = useState(1);
  const [turns, setTurns] = useState([]);
  const [currentQ, setCurrentQ] = useState("");
  const [panel, setPanel] = useState([]);
  const [consensus, setConsensus] = useState(null);
  const [conf1, setConf1] = useState(null);
  const [cost, setCost] = useState(null);
  const [sources, setSources] = useState([]);
  const [retrieving, setRetrieving] = useState(false);
  const [stage, setStage] = useState("idle");
  const [debateInfo, setDebateInfo] = useState(null);

  // chat + other (text/vision) share the message state
  const [chatModel, setChatModel] = useState("deepseek-ai/DeepSeek-V4-Pro");
  const [messages, setMessages] = useState([]);
  const [cInput, setCInput] = useState("");
  const [cRunning, setCRunning] = useState(false);
  const [cAssistant, setCAssistant] = useState("");
  const [cSources, setCSources] = useState([]);
  const [cRetrieving, setCRetrieving] = useState(false);
  const [cThinking, setCThinking] = useState(false);
  const [cCost, setCCost] = useState(null);
  const [attachImage, setAttachImage] = useState(null); // data URL for vision image input

  // other-mode model + category
  const [otherCategory, setOtherCategory] = useState("text");
  const [otherModel, setOtherModel] = useState("deepseek-ai/DeepSeek-V4-Pro");

  // embedding tool
  const [embedInput, setEmbedInput] = useState("");
  const [embedRunning, setEmbedRunning] = useState(false);
  const [embedResult, setEmbedResult] = useState(null);

  const busy = running || cRunning || embedRunning;
  const baseChatModels = fleet?.chatModels?.length ? fleet.chatModels : FALLBACK_CHAT_MODELS;
  // Champions + any dedicated GPU endpoints the user has deployed & saved.
  const chatModels = endpoints.length
    ? [...baseChatModels, ...endpoints.map((e) => ({ id: e.id, label: e.label || e.id, vendor: "Your endpoint", custom: true }))]
    : baseChatModels;
  const catalog = fleet?.catalog?.length ? fleet.catalog : [];
  const gpus = fleet?.gpus?.length ? fleet.gpus : FALLBACK_GPUS;
  const otherModels = useMemo(
    () =>
      otherCategory === "vision"
        ? catalog.filter((m) => m.vision) // capability, not just primary modality
        : catalog.filter((m) => m.modality === otherCategory),
    [catalog, otherCategory]
  );
  const activeChatModel = mode === "chat" ? chatModel : otherModel;
  const activeChatModels = mode === "chat" ? chatModels : otherModels;

  function refreshKeyAndFleet() {
    fetch("/api/key").then((r) => r.json()).then(setKeyInfo).catch(() => setKeyInfo({ hasKey: false, source: "none", masked: "", envLocked: false }));
    fetch("/api/models")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("models " + r.status))))
      .then((d) => setFleet(d && d.hasKey && Array.isArray(d.panel) && d.panel.length ? d : { ok: false, hasKey: false, online: 0, panel: [] }))
      .catch(() => setFleet({ ok: false, hasKey: false, online: 0, panel: [] }));
  }

  useEffect(() => {
    refreshKeyAndFleet();
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setConversations(JSON.parse(raw));
    } catch {}
    try {
      const ep = localStorage.getItem(ENDPOINTS_KEY);
      if (ep) setEndpoints(JSON.parse(ep));
    } catch {}
    setActiveId(newId());
  }, []);

  function saveEndpoints(list) {
    setEndpoints(list);
    try { localStorage.setItem(ENDPOINTS_KEY, JSON.stringify(list)); } catch {}
  }
  function addEndpoint(id, label) {
    id = (id || "").trim();
    if (!id || endpoints.some((e) => e.id === id)) return;
    saveEndpoints([...endpoints, { id, label: (label || "").trim() || id }]);
  }
  function removeEndpoint(id) {
    saveEndpoints(endpoints.filter((e) => e.id !== id));
  }
  function useEndpointInChat(id) {
    setChatModel(id);
    switchMode("chat");
  }

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && setExpanded(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, stage, currentQ, messages.length, cAssistant, mode, cRunning, otherCategory, embedResult]);

  // keep the OTHER-mode model valid for the selected category (and once the catalog loads)
  useEffect(() => {
    if (mode === "other" && otherCategory !== "embedding" && otherModels.length && !otherModels.some((m) => m.id === otherModel)) {
      setOtherModel(otherModels[0].id);
    }
  }, [otherCategory, otherModels, mode, otherModel]);

  function persist(list) {
    setConversations(list);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {}
  }
  function resetLive() {
    setPanel([]); setConsensus(null); setConf1(null); setCost(null);
    setSources([]); setRetrieving(false); setStage("idle"); setDebateInfo(null); setCurrentQ("");
  }
  function resetChat() {
    setCAssistant(""); setCSources([]); setCRetrieving(false); setCThinking(false); setCCost(null);
  }
  function freshSession() {
    setActiveId(newId());
    setTurns([]); resetLive(); setQuestion("");
    setMessages([]); resetChat(); setCInput(""); setAttachImage(null);
    setEmbedInput(""); setEmbedResult(null);
  }
  function switchMode(m) {
    if (busy || m === mode) return;
    setMode(m);
    freshSession();
  }
  // Each OTHER category is its own session (Text/Vision/Image must not share a thread/record).
  function switchCategory(k) {
    if (busy || k === otherCategory) return;
    setOtherCategory(k);
    setActiveId(newId());
    setMessages([]); resetChat(); setCInput(""); setAttachImage(null);
    setEmbedInput(""); setEmbedResult(null);
  }
  function newChat() {
    if (busy) return;
    freshSession();
  }
  function setLiveFromTurn(t) {
    setPanel(t.answers.map((a) => ({ ...a })));
    setConsensus(t.consensus); setConf1(t.conf1 ?? null); setCost(t.cost ?? null);
    setSources(t.sources ?? []); setRetrieving(false); setStage("done"); setDebateInfo(null);
    setCurrentQ(t.question);
  }
  function loadChat(c) {
    if (busy) return;
    const cm = c.mode || "debate";
    setMode(cm);
    setActiveId(c.id);
    if (cm === "debate") {
      setTurns(c.turns || []);
      if (c.turns?.length) setLiveFromTurn(c.turns[c.turns.length - 1]);
      else resetLive();
      setQuestion("");
      setMessages([]); resetChat();
    } else {
      // chat or other — both are message-based
      setMessages(c.messages || []);
      resetChat(); setCInput(""); setAttachImage(null);
      if (cm === "chat") {
        setChatModel(c.model || chatModels[0].id);
      } else {
        setOtherCategory(c.category || "text");
        setOtherModel(c.model || (catalog.find((m) => m.modality === (c.category || "text"))?.id) || "deepseek-ai/DeepSeek-V4-Pro");
      }
      setTurns([]); resetLive();
      setEmbedInput(""); setEmbedResult(null);
    }
  }
  function deleteChat(e, id) {
    e.stopPropagation();
    if (busy) return;
    persist(conversations.filter((c) => c.id !== id));
    if (id === activeId) freshSession();
  }
  function saveTurns(updatedTurns, id) {
    if (!updatedTurns.length) return;
    const cid = id || activeId;
    const entry = { id: cid, mode: "debate", title: updatedTurns[0].question.slice(0, 70), turns: updatedTurns, updatedAt: Date.now() };
    const others = conversations.filter((c) => c.id !== cid);
    persist([entry, ...others].sort((a, b) => b.updatedAt - a.updatedAt));
  }
  function saveChatConvo(msgs, model, id, convoMode, category) {
    if (!msgs.length) return;
    const cid = id || activeId;
    const fuc = msgs.find((m) => m.role === "user")?.content;
    const firstUser = typeof fuc === "string" ? fuc : Array.isArray(fuc) ? fuc.find((p) => p.type === "text")?.text || "Image" : "Chat";
    const entry = {
      id: cid, mode: convoMode || "chat", category, title: firstUser.slice(0, 70),
      model, messages: msgs, updatedAt: Date.now(),
    };
    const others = conversations.filter((c) => c.id !== cid);
    persist([entry, ...others].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  function stop() {
    try { abortRef.current?.abort(); } catch {}
  }

  const liveVerdictView = useMemo(() => computeVerdictView(consensus), [consensus]);

  // --- DEBATE ---
  async function run(q) {
    const text = (q ?? question).trim();
    if (!text || busy || !fleet?.hasKey || !fleet?.panel?.length) return;
    const sessionId = activeId;
    setQuestion("");
    setRunning(true);

    const answers = (fleet?.panel || []).map((p) => ({
      vendor: p.vendor, label: p.label, color: p.color, text: "", status: "thinking", tokens: null, round: 0,
    }));
    const acc = { answers, consensus: null, conf1: null, cost: null, sources: [] };
    setCurrentQ(text);
    setPanel(answers.map((a) => ({ ...a })));
    setConsensus(null); setConf1(null); setCost(null); setSources([]); setRetrieving(false); setDebateInfo(null);
    setStage("streaming");

    const sync = () => setPanel(acc.answers.map((a) => ({ ...a })));
    const scrollCol = (i) =>
      requestAnimationFrame(() => {
        const el = threadRef.current?.querySelectorAll(".live .col-body")?.[i];
        if (el) el.scrollTop = el.scrollHeight;
      });

    function emit(ev) {
      const a = acc.answers[ev.i];
      switch (ev.type) {
        case "delta":
        case "delta2":
          if (a) { a.text += ev.text; sync(); scrollCol(ev.i); }
          break;
        case "panelDone":
          if (a) { a.status = "done"; if (ev.usage) a.tokens = ev.usage.completion_tokens; sync(); }
          break;
        case "panelDone2":
          if (a) { if (!(a.text && a.text.trim()) && a.prevText) a.text = a.prevText; a.status = "done"; if (ev.usage) a.tokens = ev.usage.completion_tokens; sync(); }
          break;
        case "panelError":
        case "panelError2":
          if (a) { a.status = "error"; if (!a.text) a.text = "" + ev.message; sync(); }
          break;
        case "judging":
        case "judging2":
          setStage("judging");
          break;
        case "debateStart":
          setStage("debate"); setDebateInfo({ round: ev.round, total: ev.total });
          acc.answers.forEach((x) => { if (x.status !== "error") { x.prevText = x.text; x.text = ""; x.status = "thinking"; x.round = ev.round; } });
          sync();
          break;
        case "consensus":
          acc.consensus = { ...ev, phase: "opening" }; acc.conf1 = ev.confidence;
          setConsensus(acc.consensus); setConf1(ev.confidence); setStage(rounds > 0 ? "streaming" : "done");
          break;
        case "consensus2":
          acc.consensus = { ...ev, phase: "final", roundsRun: ev.roundsRun || rounds };
          setConsensus(acc.consensus); setStage("done");
          break;
        case "retrieving": setRetrieving(true); break;
        case "sources": acc.sources = ev.sources || []; setSources(acc.sources); setRetrieving(false); break;
        case "sourcesError": setRetrieving(false); break;
        case "cost": acc.cost = ev; setCost(ev); break;
        case "done": setStage((s) => (s === "debate" ? "done" : s)); break;
        default: break;
      }
    }

    const history = turns.map((t) => ({ question: t.question, verdict: t.consensus?.verdict || "" }));
    let errored = false;
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch("/api/quorum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, rounds, grounded, history }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) { try { emit(JSON.parse(line)); } catch {} }
        }
      }
    } catch {
      errored = true;
      acc.answers.forEach((x) => { if (x.status === "thinking") x.status = "error"; });
      sync(); setStage("done");
    }
    abortRef.current = null;

    if (!errored && acc.answers.some((x) => x.text && x.text.trim())) {
      if (acc.consensus) {
        const vv = computeVerdictView(acc.consensus);
        acc.answers.forEach((x, i) => { if (vv[i]) { x.stance = vv[i].stance; x.kind = vv[i].kind; } });
        sync();
      }
      const turn = {
        id: newId(), question: text, grounded, rounds,
        answers: acc.answers.map((a) => ({ ...a })),
        consensus: acc.consensus, conf1: acc.conf1, cost: acc.cost, sources: acc.sources,
      };
      const updated = [...turns, turn];
      setTurns(updated);
      saveTurns(updated, sessionId);
    }
    setRunning(false);
  }

  // --- CHAT / OTHER (text+vision) ---
  async function runChat(q) {
    const t = (q ?? cInput).trim();
    const img = attachImage;
    if ((!t && !img) || busy || !fleet?.hasKey) return;
    const sessionId = activeId;
    const sessionMode = mode; // "chat" or "other"
    const model = sessionMode === "chat" ? chatModel : otherModel;
    const category = sessionMode === "other" ? otherCategory : undefined;
    if (!model) return;
    const promptText = t || "What's in this image?";
    setCInput("");
    setAttachImage(null);
    setCRunning(true);
    const prevMessages = messages;
    const userContent = img
      ? [{ type: "text", text: promptText }, { type: "image_url", image_url: { url: img } }]
      : promptText;
    const base = [...prevMessages, { role: "user", content: userContent }];
    setMessages(base);
    resetChat();

    let acc = "";
    let aborted = false;
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: base, grounded, custom: endpoints.some((e) => e.id === model) }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "delta") { acc += ev.text; setCAssistant(acc); }
          else if (ev.type === "retrieving") setCRetrieving(true);
          else if (ev.type === "sources") { setCSources(ev.sources || []); setCRetrieving(false); }
          else if (ev.type === "thinking") setCThinking(true);
          else if (ev.type === "cost") setCCost(ev);
          else if (ev.type === "error") { if (!acc) acc = "" + ev.message; setCAssistant(acc); }
        }
      }
    } catch (err) {
      aborted = err?.name === "AbortError";
      if (!acc && !aborted) acc = "request failed";
      setCAssistant(acc);
    }
    abortRef.current = null;
    // Stopped before any token: drop the empty turn entirely (no fake message persisted/re-sent).
    if (aborted && !acc.trim()) {
      setMessages(prevMessages);
      setCAssistant(""); setCThinking(false); setCRetrieving(false);
      setCRunning(false);
      return;
    }
    const label = activeChatModels.find((m) => m.id === model)?.label || model;
    const finalMsgs = [...base, { role: "assistant", content: acc || "(no response)", model, label }];
    setMessages(finalMsgs);
    setCAssistant(""); setCThinking(false); setCRetrieving(false);
    saveChatConvo(finalMsgs, model, sessionId, sessionMode, category);
    setCRunning(false);
  }

  // --- EMBEDDING tool ---
  async function runEmbed(q) {
    const t = (q ?? embedInput).trim();
    if (!t || busy || !fleet?.hasKey) return;
    const model = otherModels[0]?.id || "Qwen/Qwen3-Embedding-8B";
    setEmbedRunning(true);
    setEmbedResult(null);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await fetch("/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, text: t }),
        signal: ctl.signal,
      });
      const d = await res.json();
      if (d.ok) setEmbedResult({ ...d, text: t });
      else setEmbedResult({ error: d.error || "failed", text: t });
    } catch (e) {
      setEmbedResult({ error: e?.name === "AbortError" ? "stopped" : String(e?.message || e), text: t });
    }
    abortRef.current = null;
    setEmbedRunning(false);
  }

  const noKey = fleet && !fleet.hasKey;
  const online = fleet?.panel?.filter((p) => p.online).length ?? 0;
  const priorTurns = running ? turns : turns.slice(0, -1);
  const showLive = running || turns.length > 0;
  const hasThread = turns.length > 0 || running;
  const visibleConvos = conversations.filter((c) => (c.mode || "debate") === mode);

  const tagline =
    mode === "debate" ? "the fleet shows you where it disagrees"
    : mode === "chat" ? "1-on-1 with any open model"
    : mode === "gpu" ? "rent & use Nebius GPUs"
    : mode === "code" ? "agentic coding on open models"
    : "every model your key can call";

  // First run / key removed: take over with the setup screen until a working key is saved.
  if (keyInfo && !keyInfo.hasKey) {
    return <SetupScreen onSaved={refreshKeyAndFleet} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="modeswitch">
          <button className={`ms-btn ${mode === "debate" ? "active" : ""}`} onClick={() => switchMode("debate")} disabled={busy}>Debate</button>
          <button className={`ms-btn ${mode === "chat" ? "active" : ""}`} onClick={() => switchMode("chat")} disabled={busy}>Chat</button>
          <button className={`ms-btn ${mode === "other" ? "active" : ""}`} onClick={() => switchMode("other")} disabled={busy}>Other</button>
          <button className={`ms-btn ${mode === "gpu" ? "active" : ""}`} onClick={() => switchMode("gpu")} disabled={busy}>GPU</button>
          <button className={`ms-btn ${mode === "code" ? "active" : ""}`} onClick={() => switchMode("code")} disabled={busy}>Code</button>
        </div>
        {mode === "gpu" || mode === "code" ? (
          <div className="convo-list">
            <div className="convo-empty">{mode === "code"
              ? "Agentic coding over a local folder — point it at a project, then give the agent tasks. It reads, edits, and (if enabled) runs commands."
              : "Rent dedicated GPUs and use any endpoint you deploy. Prices are live from your Nebius account."}</div>
          </div>
        ) : (
        <><button className="newchat" onClick={newChat} disabled={busy}>+ New {mode === "debate" ? "debate" : "session"}</button>
        <div className="convo-list">
          {visibleConvos.length === 0 && <div className="convo-empty">No saved {mode === "debate" ? "debates" : "sessions"} yet</div>}
          {visibleConvos.map((c) => (
            <div key={c.id} className={`convo-item ${c.id === activeId ? "active" : ""}`} onClick={() => loadChat(c)} title={c.title}>
              <span className="convo-title">{c.title}</span>
              <button className="convo-del" onClick={(e) => deleteChat(e, c.id)} disabled={busy} title="Delete">✕</button>
            </div>
          ))}
        </div></>
        )}
        <div className="sidebar-foot"><img src="/nebius-logo.svg" alt="Nebius" /></div>
      </aside>

      <main className="main">
        <header className="hdr">
          <div className="brand">
            <span className="logo">Quorum</span>
            <span className="tag">{tagline}</span>
          </div>
          <div className="hdr-right">
            <div className={`fleet ${noKey ? "dark" : ""}`}>
              <img src="/nebius-logo.svg" alt="Nebius Token Factory" />
              <span className="sep" />
              <span className="fleet-stat">
                <span className={`dot ${noKey ? "off" : "on"}`} />
                {noKey ? "no key — dark" : `${online}/5 online · ${fleet?.online ?? "…"} models`}
              </span>
            </div>
            <button className="gear" onClick={() => setShowSettings(true)} title="Settings — manage your API key">Settings</button>
          </div>
        </header>

        {noKey && (
          <div className="banner">
            Set <code>NEBIUS_API_KEY</code> in <code>.env.local</code> and restart. Pull the key and Quorum goes
            dark — the fleet <em>is</em> the product.
          </div>
        )}

        {mode === "debate" && (
          <>
            <div className="thread" ref={threadRef}>
              {!hasThread && (
                <div className="empty">
                  <div className="empty-title">Convene a panel of five open models.</div>
                  <div className="empty-sub">
                    Ask anything contested. They answer in parallel, debate across rounds, and show you exactly where
                    they disagree — grounded in a live Nebius-embedded knowledge base.
                  </div>
                  <div className="chips">
                    {EXAMPLES.map((ex) => (
                      <button key={ex} className="chip" disabled={noKey} onClick={() => run(ex)}>{ex}</button>
                    ))}
                  </div>
                </div>
              )}
              {priorTurns.map((t) => (
                <TurnCard key={t.id} turn={t} onOpen={setExpanded} />
              ))}
              {showLive && (
                <div className="turn live">
                  <div className="userbubble">{currentQ}</div>
                  {retrieving && (
                    <div className="retrieving"><span className="b-dot" /> Retrieving current facts — embedding with Qwen3-Embedding-8B on Nebius…</div>
                  )}
                  {sources.length > 0 && (
                    <div className="sources">
                      <span className="src-label">Grounded · retrieved</span>
                      <div className="src-chips">
                        {sources.map((s, i) => (<span className="src-chip" key={i}>{s.title} <b>{Number(s.score).toFixed(2)}</b></span>))}
                      </div>
                    </div>
                  )}
                  {stage === "debate" && debateInfo && (
                    <div className="debatebar"><span className="b-dot" /> Debate round {debateInfo.round} of {debateInfo.total} — the council reads each other&apos;s latest answers and revises.</div>
                  )}
                  <Columns answers={panel} verdictView={liveVerdictView} hasConsensus={!!consensus} onOpen={setExpanded} />
                  {(stage === "judging" || consensus) && (
                    <Verdict consensus={consensus} conf1={conf1} judging={stage === "judging" && !consensus} />
                  )}
                </div>
              )}
            </div>

            <div className="composer">
              <textarea className="q" rows={1} placeholder={turns.length ? "Add to the debate…  (Shift+Enter for a new line)" : "Ask the panel anything contested…  (Shift+Enter for a new line)"}
                value={question} onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => composerKey(e, run)} disabled={running || noKey} />
              <button type="button" className={`ground ${grounded ? "on" : ""}`} onClick={() => setGrounded((g) => !g)} disabled={running || noKey} title="Ground answers in a Nebius-embedded knowledge base (RAG)">
                <span className="g-dot" /> RAG {grounded ? "ON" : "OFF"}
              </button>
              <select className="rounds" value={rounds} onChange={(e) => setRounds(+e.target.value)} disabled={running || noKey} title="How many debate rounds the council runs">
                <option value={0}>No debate</option>
                <option value={1}>1 round</option>
                <option value={2}>2 rounds</option>
                <option value={3}>3 rounds</option>
              </select>
              {running ? (
                <button className="go stop" onClick={stop}>Stop</button>
              ) : (
                <button className="go" onClick={() => run()} disabled={noKey}>{turns.length ? "Continue" : "Convene"}</button>
              )}
            </div>

            <Meter cost={cost} cap="Nebius cost · last turn" note="vs GPT-5.5 · 5 models, 1 bill" />
          </>
        )}

        {mode === "chat" && (
          <ChatView
            models={chatModels} model={chatModel} setModel={setChatModel}
            messages={messages} assistant={cAssistant} running={cRunning} retrieving={cRetrieving}
            thinking={cThinking} sources={cSources} input={cInput} setInput={setCInput}
            onSend={runChat} onStop={stop} grounded={grounded} setGrounded={setGrounded}
            cost={cCost} noKey={noKey} threadRef={threadRef}
          />
        )}

        {mode === "other" && (
          <>
            <div className="other-cats">
              {CATEGORIES.map((c) => (
                <button key={c.key} className={`cat-btn ${otherCategory === c.key ? "active" : ""}`}
                  onClick={() => switchCategory(c.key)} disabled={busy}>
                  {c.label}
                </button>
              ))}
              <span className="cat-count">{catalog.length} models on your key</span>
            </div>
            <div className="cat-desc">{CATEGORIES.find((c) => c.key === otherCategory)?.desc}</div>

            {otherCategory === "embedding" ? (
              <EmbedView
                model={otherModels[0]} input={embedInput} setInput={setEmbedInput}
                running={embedRunning} onRun={runEmbed} onStop={stop} result={embedResult} noKey={noKey} threadRef={threadRef}
              />
            ) : (
              <ChatView
                models={otherModels} model={otherModel} setModel={setOtherModel} grouped
                messages={messages} assistant={cAssistant} running={cRunning} retrieving={cRetrieving}
                thinking={cThinking} sources={cSources} input={cInput} setInput={setCInput}
                onSend={runChat} onStop={stop} grounded={grounded} setGrounded={setGrounded}
                cost={cCost} noKey={noKey} threadRef={threadRef}
                allowImage={otherCategory === "vision"} attachImage={attachImage} setAttachImage={setAttachImage}
              />
            )}
          </>
        )}

        {mode === "gpu" && (
          <GpuView gpus={gpus} endpoints={endpoints} onAdd={addEndpoint} onRemove={removeEndpoint} onUse={useEndpointInChat} noKey={noKey} threadRef={threadRef} />
        )}

        {mode === "code" && <CodeView models={chatModels} noKey={noKey} />}
      </main>

      {expanded && (
        <div className="modal-bg" onClick={() => setExpanded(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-id">
                <span className="vendor">{expanded.vendor}</span>
                <span className="modal-title">{expanded.label}</span>
              </div>
              <div className="modal-meta">
                {expanded.round >= 1 && <span className="r2">R{expanded.round}</span>}
                {expanded.tokens != null && <span className="modal-tok">{expanded.tokens} tok</span>}
                <button className="modal-x" onClick={() => setExpanded(null)} aria-label="Close">✕</button>
              </div>
            </div>
            {expanded.stance && <div className={`stance ${expanded.kind || "maj"}`}>{expanded.stance}</div>}
            <div className="modal-body">{expanded.text || "—"}</div>
            <div className="modal-foot">Esc or click outside to close</div>
          </div>
        </div>
      )}

      {showSettings && keyInfo && (
        <SettingsModal keyInfo={keyInfo} onClose={() => setShowSettings(false)} onChanged={refreshKeyAndFleet} />
      )}
    </div>
  );
}

function SetupScreen({ onSaved }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) });
      const d = await r.json();
      if (d.ok) onSaved();
      else { setErr(d.error || "Could not save the key."); setBusy(false); }
    } catch (e) { setErr(String(e?.message || e)); setBusy(false); }
  }
  return (
    <div className="setup">
      <div className="setup-card">
        <img className="setup-logo" src="/nebius-logo.svg" alt="Nebius" />
        <h1 className="setup-title">Quorum</h1>
        <p className="setup-sub">
          Quorum runs entirely on your own <b>Nebius Token Factory</b> key — your models, your bill, on your machine.
          Paste your key to begin. It is stored locally on this computer and never leaves it.
        </p>
        <input className="setup-input" type="password" placeholder="Nebius API key" value={key}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} disabled={busy} autoFocus />
        {err && <div className="setup-err">{err}</div>}
        <button className="setup-go" onClick={save} disabled={busy || !key.trim()}>{busy ? "Checking your key…" : "Start"}</button>
        <a className="setup-link" href="https://tokenfactory.nebius.com" target="_blank" rel="noreferrer">Get a key from Nebius Token Factory →</a>
      </div>
    </div>
  );
}

function SettingsModal({ keyInfo, onClose, onChanged }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function replace() {
    const k = key.trim();
    if (!k || busy) return;
    setBusy(true); setErr("");
    const r = await fetch("/api/key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) });
    const d = await r.json(); setBusy(false);
    if (d.ok) { setKey(""); onChanged(); onClose(); } else setErr(d.error || "Could not save the key.");
  }
  async function remove() {
    if (busy || !window.confirm("Remove your saved Nebius key? Quorum will return to the setup screen.")) return;
    setBusy(true); setErr("");
    const r = await fetch("/api/key", { method: "DELETE" });
    const d = await r.json(); setBusy(false);
    if (d.ok) { onChanged(); onClose(); } else setErr(d.error || "Could not remove the key.");
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <span className="modal-title">Settings</span>
          <button className="modal-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="set-row">
          <span className="set-label">Nebius API key</span>
          <code className="set-key">{keyInfo.masked || "—"}</code>
        </div>
        {keyInfo.envLocked ? (
          <div className="set-note">Your key is set via <code>.env.local</code> (environment). Edit it there and restart to change it.</div>
        ) : (
          <>
            <input className="set-input" type="password" placeholder="Replace with a new key…" value={key}
              onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && replace()} disabled={busy} />
            {err && <div className="setup-err">{err}</div>}
            <div className="set-actions">
              <button className="vec-btn" onClick={replace} disabled={busy || !key.trim()}>{busy ? "…" : "Save new key"}</button>
              <button className="vec-btn danger" onClick={remove} disabled={busy}>Remove key</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatView({ models, model, setModel, grouped, messages, assistant, running, retrieving, thinking, sources, input, setInput, onSend, onStop, grounded, setGrounded, cost, noKey, threadRef, allowImage, attachImage, setAttachImage }) {
  const labelOf = (id) => models.find((m) => m.id === id)?.label || id;
  const empty = messages.length === 0 && !running;
  function readImageFile(f) {
    if (!f || f.size > 5 * 1024 * 1024) return; // 5MB cap
    const r = new FileReader();
    r.onload = () => setAttachImage(String(r.result));
    r.readAsDataURL(f);
  }
  function onPickImage(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    readImageFile(f);
  }
  // Paste an image straight from the clipboard (screenshots, copied images).
  function onPasteImage(e) {
    if (!allowImage || !setAttachImage) return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          readImageFile(f);
          return;
        }
      }
    }
  }
  const groups = useMemo(() => {
    if (!grouped) return null;
    const g = {};
    models.forEach((m) => { (g[m.vendor] = g[m.vendor] || []).push(m); });
    return g;
  }, [grouped, models]);
  return (
    <>
      <div className="thread" ref={threadRef}>
        {empty && (
          <div className="empty">
            <div className="empty-title">{allowImage ? "Show a model an image." : grouped ? "Use any model your key can call." : "Talk to the top model from any provider."}</div>
            <div className="empty-sub">
              {allowImage ? (
                "Attach an image with “+ Image” — or just paste one (Ctrl/Cmd+V) — then ask the vision model to describe it, read text in it, or analyze it. Full conversation memory and a real-cost meter."
              ) : grouped ? (
                <>Pick a category and model above, then talk to it like any LLM — full conversation memory, optional Nebius-grounded knowledge, real-cost meter, and stop any time.</>
              ) : (
                <>The picker below is the <b>champions tier</b> — the single best model from every provider (DeepSeek, Qwen, Kimi, GLM, Nemotron, MiniMax, Hermes, INTELLECT, GPT-OSS, Llama, Gemma), all on one Nebius bill. Full conversation memory, optional grounding, real-cost meter. “·” marks a reasoning model.</>
              )}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div className="chat-msg user" key={i}>
              <div className="chat-bubble">
                {Array.isArray(m.content) ? (
                  <>
                    {m.content.find((p) => p.type === "image_url")?.image_url?.url && (
                      <img className="msg-img" src={m.content.find((p) => p.type === "image_url").image_url.url} alt="attachment" />
                    )}
                    {m.content.find((p) => p.type === "text")?.text}
                  </>
                ) : (
                  m.content
                )}
              </div>
            </div>
          ) : (
            <div className="chat-msg assistant" key={i}>
              <div className="chat-who">{m.label || labelOf(m.model)}</div>
              <div className="chat-bubble md"><Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown></div>
              <CopyButton text={m.content} />
            </div>
          )
        )}
        {running && (
          <div className="chat-msg assistant">
            <div className="chat-who">{labelOf(model)}</div>
            {retrieving && (<div className="retrieving"><span className="b-dot" /> Retrieving facts — embedding with Qwen3-Embedding-8B on Nebius…</div>)}
            {sources.length > 0 && (
              <div className="sources">
                <span className="src-label">Grounded · retrieved</span>
                <div className="src-chips">{sources.map((s, i) => (<span className="src-chip" key={i}>{s.title} <b>{Number(s.score).toFixed(2)}</b></span>))}</div>
              </div>
            )}
            {assistant ? (
              <div className="chat-bubble md"><Markdown remarkPlugins={[remarkGfm]}>{assistant}</Markdown><span className="caret">▌</span></div>
            ) : thinking ? (
              <div className="chat-bubble thinking-bubble"><span className="ring-spin">◍</span> thinking…</div>
            ) : (
              <div className="chat-bubble thinking-bubble">▌</div>
            )}
          </div>
        )}
      </div>

      <div className="composer">
        {allowImage && attachImage && (
          <div className="attach-thumb">
            <img src={attachImage} alt="attachment" />
            <button onClick={() => setAttachImage(null)} title="Remove">×</button>
          </div>
        )}
        <textarea className="q" rows={1} placeholder={allowImage ? (attachImage ? "Ask about the image…  (Shift+Enter for a new line)" : "Attach or paste an image, then ask about it…") : messages.length ? "Reply…  (Shift+Enter for a new line)" : "Message the model…  (Shift+Enter for a new line)"} value={input}
          onChange={(e) => setInput(e.target.value)} onPaste={onPasteImage}
          onKeyDown={(e) => composerKey(e, onSend)} disabled={running || noKey} />
        {allowImage && (
          <label className={`attach-btn ${running || noKey ? "off" : ""}`} title="Attach an image for the vision model">
            + Image
            <input type="file" accept="image/*" onChange={onPickImage} disabled={running || noKey} hidden />
          </label>
        )}
        <button type="button" className={`ground ${grounded ? "on" : ""}`} onClick={() => setGrounded((g) => !g)} disabled={running || noKey} title="Ground in a Nebius-embedded knowledge base (RAG)">
          <span className="g-dot" /> RAG {grounded ? "ON" : "OFF"}
        </button>
        <select className="rounds modelsel" value={model} onChange={(e) => setModel(e.target.value)} disabled={running || noKey} title="Which model you're talking to">
          {grouped
            ? models.length === 0
              ? <option value="">loading models…</option>
              : Object.keys(groups).map((v) => (
                  <optgroup key={v} label={v}>
                    {groups[v].map((m) => (<option key={m.id} value={m.id} disabled={m.online === false && m.id !== model}>{m.label}{m.reasoning ? " ·" : ""}</option>))}
                  </optgroup>
                ))
            : models.map((m) => (<option key={m.id} value={m.id} disabled={m.online === false && m.id !== model}>{m.vendor ? `${m.vendor} — ${m.label}` : m.label}{m.reasoning ? " ·" : ""}</option>))}
        </select>
        {running ? (
          <button className="go stop" onClick={onStop}>Stop</button>
        ) : (
          <button className="go" onClick={() => onSend()} disabled={noKey || !model || (grouped && models.length === 0)}>Send</button>
        )}
      </div>

      <Meter cost={cost} cap="Nebius cost · last message" note={`${labelOf(cost?.model || model)} · 1 model`} />
    </>
  );
}

function EmbedView({ model, input, setInput, running, onRun, onStop, result, noKey, threadRef }) {
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const fullVec = result && !result.error ? (result.vector || result.sample) : null;
  function copyVec() {
    if (!fullVec) return;
    navigator.clipboard?.writeText("[" + fullVec.join(", ") + "]").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }
  return (
    <>
      <div className="thread" ref={threadRef}>
        <div className="empty">
          <div className="empty-title">Text → embedding vector</div>
          <div className="empty-sub">
            Turn any text into a high-dimensional vector with <b>{model?.label || "Qwen3 Embedding 8B"}</b> on Nebius —
            the same embeddings that power search and RAG.
          </div>
        </div>
        {result && (
          result.error ? (
            <div className="embed-result err">{result.error}</div>
          ) : (
            <div className="embed-result">
              <div className="embed-meta">
                <span><b>{result.dims}</b> dims</span>
                <span><b>{result.tokens}</b> tokens</span>
                <span>‖v‖ = <b>{Number(result.norm).toFixed(3)}</b></span>
                <span>cost <b>{fmt(result.cost)}</b></span>
              </div>
              {showFull && fullVec ? (
                <div className="embed-vec full">[{fullVec.map((v) => Number(v).toFixed(6)).join(", ")}]</div>
              ) : (
                <div className="embed-vec">[{result.sample.map((v) => Number(v).toFixed(5)).join(", ")}, … <span className="embed-more">{result.dims - result.sample.length} more</span>]</div>
              )}
              <div className="embed-actions">
                <button className="vec-btn" onClick={() => setShowFull((s) => !s)}>
                  {showFull ? "Collapse" : `Show all ${result.dims} dims`}
                </button>
                <button className="vec-btn" onClick={copyVec} disabled={!fullVec}>
                  {copied ? "Copied ✓" : "Copy vector"}
                </button>
              </div>
            </div>
          )
        )}
      </div>
      <div className="composer">
        <textarea className="q" rows={1} placeholder="Text to embed…  (Shift+Enter for a new line)" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => composerKey(e, onRun)} disabled={running || noKey} />
        {running ? (
          <button className="go stop" onClick={onStop}>Stop</button>
        ) : (
          <button className="go" onClick={() => onRun()} disabled={noKey}>Embed</button>
        )}
      </div>
    </>
  );
}

function FeedItem({ it }) {
  if (it.kind === "user") return <div className="fi-user">{it.text}</div>;
  if (it.kind === "assistant") return <div className="fi-assistant"><Markdown remarkPlugins={[remarkGfm]}>{it.text}</Markdown></div>;
  if (it.kind === "tool") return <div className="fi-tool"><span className="fi-arrow">→</span> {it.name} <span className="fi-args">{it.args?.path || it.args?.command || (it.args && Object.keys(it.args).length ? JSON.stringify(it.args) : "")}</span></div>;
  if (it.kind === "result") return <div className="fi-result">{String(it.text).slice(0, 280)}{String(it.text).length > 280 ? "…" : ""}</div>;
  if (it.kind === "file") return <div className="fi-file">wrote {it.path}</div>;
  if (it.kind === "run") return <div className="fi-run">$ {it.command}</div>;
  if (it.kind === "error") return <div className="fi-error">{it.text}</div>;
  return null;
}

function CodeView({ models, noKey }) {
  const [root, setRoot] = useState("");
  const [tree, setTree] = useState([]);
  const [openPath, setOpenPath] = useState("");
  const [fileText, setFileText] = useState("");
  const [model, setModel] = useState(models[0]?.id || "deepseek-ai/DeepSeek-V4-Pro");
  const [allowRun, setAllowRun] = useState(false);
  const [task, setTask] = useState("");
  const [feed, setFeed] = useState([]);
  const [convo, setConvo] = useState([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const abortRef = useRef(null);
  const feedRef = useRef(null);

  useEffect(() => { try { const w = localStorage.getItem("quorum.workspace"); if (w) setRoot(w); } catch {} }, []);
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [feed, running]);

  async function openWorkspace(p) {
    const dir = (p ?? root).trim();
    if (!dir) return;
    setErr("");
    try {
      const r = await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list", root: dir }) });
      const d = await r.json();
      if (!d.ok) { setErr(d.error); setTree([]); return; }
      setRoot(dir); setTree(d.files);
      try { localStorage.setItem("quorum.workspace", dir); } catch {}
    } catch (e) { setErr(String(e?.message || e)); }
  }
  async function refreshTree() {
    if (!root) return;
    try { const r = await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list", root }) }); const d = await r.json(); if (d.ok) setTree(d.files); } catch {}
  }
  async function openFile(p) {
    setOpenPath(p);
    try { const r = await fetch("/api/fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", root, path: p }) }); const d = await r.json(); setFileText(d.ok ? d.content : "// " + d.error); } catch (e) { setFileText("// " + String(e?.message || e)); }
  }
  function stop() { abortRef.current?.abort(); setRunning(false); }

  async function runAgent() {
    const t = task.trim();
    if (!t || running || !root) return;
    setTask("");
    const nc = [...convo, { role: "user", content: t }];
    setConvo(nc);
    setFeed((f) => [...f, { kind: "user", text: t }]);
    setRunning(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    let finalText = "";
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, model, allowRun, messages: nc }), signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error("agent error " + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.type === "assistant") setFeed((f) => [...f, { kind: "assistant", text: o.text }]);
          else if (o.type === "tool_call") setFeed((f) => [...f, { kind: "tool", name: o.name, args: o.args }]);
          else if (o.type === "tool_result") setFeed((f) => [...f, { kind: "result", name: o.name, text: o.result }]);
          else if (o.type === "file_written") { setFeed((f) => [...f, { kind: "file", path: o.path }]); refreshTree(); if (o.path === openPath) openFile(o.path); }
          else if (o.type === "running") setFeed((f) => [...f, { kind: "run", command: o.command }]);
          else if (o.type === "final") finalText = o.text;
          else if (o.type === "error") setFeed((f) => [...f, { kind: "error", text: o.message }]);
        }
      }
    } catch (e) { if (e?.name !== "AbortError") setFeed((f) => [...f, { kind: "error", text: String(e?.message || e) }]); }
    if (finalText) setConvo((c) => [...c, { role: "assistant", content: finalText }]);
    setRunning(false);
  }

  return (
    <div className="code-wrap">
      <div className="code-bar">
        <input className="code-path" placeholder="C:\path\to\your\project" value={root} onChange={(e) => setRoot(e.target.value)} onKeyDown={(e) => e.key === "Enter" && openWorkspace()} disabled={running} />
        <button className="vec-btn" onClick={() => openWorkspace()} disabled={running}>Open</button>
        <select className="code-model" value={model} onChange={(e) => setModel(e.target.value)} disabled={running} title="Coding model">
          {models.map((m) => <option key={m.id} value={m.id}>{m.vendor ? m.vendor + " — " : ""}{m.label}</option>)}
        </select>
        <button className={`code-cmd ${allowRun ? "on" : ""}`} onClick={() => setAllowRun((v) => !v)} disabled={running} title="Let the agent run shell commands (tests, build, git). Your machine — use with care.">
          Commands {allowRun ? "ON" : "OFF"}
        </button>
      </div>
      {err && <div className="code-err">{err}</div>}
      <div className="code-body">
        <div className="code-tree">
          {tree.length === 0 ? <div className="code-hint">Open a project folder to start.</div> :
            tree.map((n) => n.type === "dir"
              ? <div key={n.path} className="code-node dir" style={{ paddingLeft: 8 + n.depth * 12 }}>{n.path.split("/").pop()}</div>
              : <div key={n.path} className={`code-node file ${openPath === n.path ? "open" : ""}`} style={{ paddingLeft: 8 + n.depth * 12 }} onClick={() => openFile(n.path)}>{n.path.split("/").pop()}</div>
            )}
        </div>
        <div className="code-main">
          <div className="code-viewer">
            {openPath ? <><div className="code-viewer-hd">{openPath}</div><pre className="code-file">{fileText}</pre></> : <div className="code-hint pad">Select a file to view it. The agent edits files directly on disk — watch the tree update as it works.</div>}
          </div>
          <div className="code-agent">
            <div className="code-feed" ref={feedRef}>
              {feed.length === 0 && <div className="code-hint pad">Give the agent a task — &ldquo;add a dark-mode toggle&rdquo;, &ldquo;fix the failing test&rdquo;, &ldquo;explain how routing works&rdquo;. It reads and edits your files{allowRun ? " and runs commands" : ""}.</div>}
              {feed.map((it, i) => <FeedItem key={i} it={it} />)}
              {running && <div className="code-working"><span className="ring-spin">◍</span> working…</div>}
            </div>
            <div className="code-composer">
              <textarea className="q" rows={1} placeholder={root ? "Tell the agent what to build or fix…  (Enter to run, Shift+Enter newline)" : "Open a folder first"} value={task}
                onChange={(e) => setTask(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runAgent(); } }} disabled={running || noKey || !root} />
              {running ? <button className="go stop" onClick={stop}>Stop</button> : <button className="go" onClick={runAgent} disabled={noKey || !root || !task.trim()}>Run</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FineTunePanel({ onAdd, onUse, noKey }) {
  const [model, setModel] = useState(FT_MODELS[0].id);
  const [data, setData] = useState("");
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sel = FT_MODELS.find((m) => m.id === model) || FT_MODELS[0];

  async function refresh() {
    try {
      const r = await fetch("/api/finetune", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "list" }) });
      const d = await r.json();
      if (d.ok) setJobs(d.jobs || []);
    } catch {}
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    const running = jobs.some((j) => ["validating_files", "queued", "running", "pending"].includes(j.status));
    if (!running) return;
    const t = setTimeout(refresh, 6000);
    return () => clearTimeout(t);
  }, [jobs]);

  async function start() {
    setErr("");
    if (!data.trim().split("\n").filter((l) => l.trim()).length) { setErr("Add training examples first (or load the sample)."); return; }
    if (!window.confirm(`Start training ${sel.label}?\n\nThis runs on a Nebius GPU, billed ~$${sel.per1m}/1M training tokens. Charges begin once the job runs.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/finetune", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", model, jsonl: data }) });
      const d = await r.json();
      if (!d.ok) setErr(d.error || "failed to start");
      else { setData(""); await refresh(); }
    } catch (e) { setErr(String(e?.message || e)); }
    setBusy(false);
  }

  return (
    <div className="gpu-panel">
      <div className="gpu-calc-h">Train a model — fine-tuning</div>
      <p className="gpu-sub">
        Teach an open model your style or knowledge: give examples, Nebius trains it on a GPU, and you get your <b>own
        model id</b> — it lands in your <b>Chat</b> picker automatically. Billed per 1M training tokens.
      </p>
      <div className="gpu-calc-row">
        <label>Base model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || noKey}>
            {FT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — ~${m.per1m}/1M</option>)}
          </select>
        </label>
      </div>
      <div className="ft-data-hd">
        <span>Training data — one JSON object per line: {'{"messages":[{"role":"user",…},{"role":"assistant",…}]}'}</span>
        <button className="vec-btn" onClick={() => setData(FT_SAMPLE)} disabled={busy}>Load sample</button>
      </div>
      <textarea className="ft-data" value={data} onChange={(e) => setData(e.target.value)} disabled={busy || noKey}
        placeholder={'{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}]}'} />
      {err && <div className="ft-err">{err}</div>}
      <button className="go ft-start" onClick={start} disabled={busy || noKey || !data.trim()}>{busy ? "Starting…" : "Start training"}</button>

      <div className="ft-jobs">
        <div className="ft-jobs-hd"><span>Your training jobs</span><button className="vec-btn" onClick={refresh}>Refresh</button></div>
        {jobs.length === 0 ? (
          <div className="gpu-ep-empty">No training jobs yet.</div>
        ) : jobs.map((j) => (
          <div key={j.jobId} className="ft-job">
            <div className="ft-job-main">
              <span className={`ft-badge s-${j.status}`}>{j.status}</span>
              <span className="ft-job-model">{j.model}</span>
            </div>
            {j.fineTuned ? (
              <div className="ft-job-done">
                <code>{j.fineTuned}</code>
                <button className="vec-btn" onClick={() => { onAdd(j.fineTuned, "Fine-tuned " + (j.model || "").split("/").pop()); onUse(j.fineTuned); }}>Use in Chat →</button>
              </div>
            ) : <span className="ft-job-id">{j.jobId}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function GpuView({ gpus, endpoints, onAdd, onRemove, onUse, noKey, threadRef }) {
  const [sel, setSel] = useState(gpus[0]?.id || "L40S");
  const [hours, setHours] = useState(2);
  const [epId, setEpId] = useState("");
  const [epLabel, setEpLabel] = useState("");
  const g = gpus.find((x) => x.id === sel) || gpus[0];
  const rate = g?.perHour || 0;
  const money = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const h = Math.max(0, Number(hours) || 0);
  return (
    <div className="thread gpu-wrap" ref={threadRef}>
      <div className="gpu-intro">
        <div className="gpu-h">Rent a GPU on Nebius</div>
        <p className="gpu-sub">
          Deploy any model onto a dedicated GPU — billed per <b>GPU-hour</b>. This is how you run what serverless
          can&apos;t: your own <b>image generation</b> (FLUX/SDXL), a private LLM, or a fine-tuned model. You start the
          GPU in the Nebius console; once it&apos;s running, its endpoint works right here in Quorum.
        </p>
        <div className="gpu-note">
          ⓘ Renting is a console action — it can&apos;t be done from the API key alone (verified: this key has no
          provisioning endpoint). Quorum gives you the live prices, a calculator, the exact steps, and a place to use
          your endpoint once it&apos;s live.
        </div>
      </div>

      <div className="gpu-grid">
        {gpus.map((x) => (
          <button key={x.id} className={`gpu-card ${sel === x.id ? "sel" : ""}`} onClick={() => setSel(x.id)}>
            <div className="gpu-card-top">
              <span className="gpu-tier">{x.tier}</span>
              <span className="gpu-rate">{money(x.perHour)}<small>/hr</small></span>
            </div>
            <div className="gpu-name">{x.label}</div>
            <div className="gpu-vram">{x.vram} VRAM</div>
            <div className="gpu-good">{x.good}</div>
          </button>
        ))}
      </div>

      <div className="gpu-panel">
        <div className="gpu-calc-h">Cost calculator</div>
        <div className="gpu-calc-row">
          <label>GPU
            <select value={sel} onChange={(e) => setSel(e.target.value)}>
              {gpus.map((x) => <option key={x.id} value={x.id}>{x.label} — {money(x.perHour)}/hr</option>)}
            </select>
          </label>
          <label>Hours
            <input type="number" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
          </label>
        </div>
        <div className="gpu-calc-out">
          <div className="gpu-stat big"><span>{h} hour{h === 1 ? "" : "s"} on {g?.label}</span><b>{money(rate * h)}</b></div>
          <div className="gpu-stat"><span>Per hour</span><b>{money(rate)}</b></div>
          <div className="gpu-stat"><span>Per day (24h)</span><b>{money(rate * 24)}</b></div>
          <div className="gpu-stat"><span>Per month (730h)</span><b>{money(rate * 730)}</b></div>
        </div>
        <div className="gpu-tip">Tip: only run it while you need it. A 2-hour FLUX demo on an L40S is just {money(2 * 2)}.</div>
      </div>

      <div className="gpu-panel">
        <div className="gpu-calc-h">How to rent — exact steps</div>
        <ol className="gpu-steps">
          <li>Open your <b>Nebius Token Factory console</b> (the dashboard with your Prices page).</li>
          <li>Left nav → <b>Inference → Model endpoints</b>.</li>
          <li><b>Deploy</b> / create an endpoint: pick a model (a FLUX image model, or any LLM) and a GPU from above.</li>
          <li>Confirm — billing starts at the GPU-hour rate while it runs. <b>Pause or delete it when done</b> to stop charges.</li>
          <li>Copy the endpoint&apos;s <b>model id</b> and paste it below to use it in Quorum.</li>
        </ol>
        <a className="gpu-deploy" href="https://console.nebius.com" target="_blank" rel="noreferrer">Open Nebius console ↗</a>
      </div>

      <div className="gpu-panel">
        <div className="gpu-calc-h">Use a deployed endpoint</div>
        <p className="gpu-sub">Paste the model id of an endpoint you&apos;ve deployed. It becomes selectable in <b>Chat</b> and runs on your GPU.</p>
        <div className="gpu-ep-add">
          <input placeholder="endpoint model id (e.g. my-org/flux-dev-ep)" value={epId} onChange={(e) => setEpId(e.target.value)} disabled={noKey} />
          <input placeholder="label (optional)" value={epLabel} onChange={(e) => setEpLabel(e.target.value)} disabled={noKey} />
          <button className="go" onClick={() => { onAdd(epId, epLabel); setEpId(""); setEpLabel(""); }} disabled={noKey || !epId.trim()}>Add</button>
        </div>
        {endpoints.length === 0 ? (
          <div className="gpu-ep-empty">No endpoints saved yet.</div>
        ) : (
          <div className="gpu-ep-list">
            {endpoints.map((e) => (
              <div key={e.id} className="gpu-ep">
                <div className="gpu-ep-id"><b>{e.label}</b><span>{e.id}</span></div>
                <div className="gpu-ep-actions">
                  <button className="vec-btn" onClick={() => onUse(e.id)}>Use in Chat →</button>
                  <button className="vec-btn" onClick={() => onRemove(e.id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <FineTunePanel onAdd={onAdd} onUse={onUse} noKey={noKey} />
    </div>
  );
}

function Meter({ cost, cap, note }) {
  const priced = !(cost && cost.priced === false);
  const savGpt = cost && priced && cost.nebiusUsd > 0 ? cost.gptUsd / cost.nebiusUsd : null;
  const savGemini = cost && priced && cost.nebiusUsd > 0 ? cost.geminiUsd / cost.nebiusUsd : null;
  const savOpus = cost && priced && cost.nebiusUsd > 0 ? cost.opusUsd / cost.nebiusUsd : null;
  return (
    <footer className={`meter ${cost ? "live" : ""}`}>
      <div className="m-block hero">
        <span className="m-cap">{cap || "Nebius cost"}</span>
        <span className="m-big">{cost ? (priced ? fmt(cost.nebiusUsd) : "n/a") : "$0.000000"}</span>
        <span className="m-sub">{cost ? `${cost.totalTok.toLocaleString()} real tokens${cost.grounded ? " · grounded" : ""}${priced ? "" : " · unpriced model"}` : "awaiting query"}</span>
      </div>
      <div className="m-vs">vs</div>
      <div className="m-block"><span className="m-cap">GPT-5.5</span><span className="m-big muted">{savGpt ? fmt(cost.gptUsd) : "—"}</span><span className="m-sub">{savGpt ? `${savGpt.toFixed(1)}× more` : "—"}</span></div>
      <div className="m-block"><span className="m-cap">Gemini 3.1 Pro</span><span className="m-big muted">{savGemini ? fmt(cost.geminiUsd) : "—"}</span><span className="m-sub">{savGemini ? `${savGemini.toFixed(1)}× more` : "—"}</span></div>
      <div className="m-block"><span className="m-cap">Claude Opus</span><span className="m-big muted">{savOpus ? fmt(cost.opusUsd) : "—"}</span><span className="m-sub">{savOpus ? `${savOpus.toFixed(1)}× more` : "—"}</span></div>
      <div className="m-block savings"><span className="m-cap">Nebius is</span><span className="m-big"><span className="hl">{savGpt ? `${savGpt.toFixed(0)}× cheaper` : "—"}</span></span><span className="m-sub">{note || "vs GPT-5.5"}</span></div>
    </footer>
  );
}

function Columns({ answers, verdictView, hasConsensus, onOpen }) {
  return (
    <section className="grid">
      {answers.map((p, i) => {
        const v = verdictView?.[i];
        const enriched = { ...p, stance: p.stance ?? v?.stance, kind: p.kind ?? v?.kind };
        return (
          <div className={`col ${p.text ? "clickable" : ""}`} key={i} onClick={() => p.text && onOpen(enriched)} title={p.text ? "Click to open fullscreen" : undefined}>
            <div className="col-hd">
              <div className="col-meta">
                <span className="vendor">{p.vendor}</span>
                <span className="model">{p.label}</span>
              </div>
              <div className="col-st">
                {p.round >= 1 && <span className="r2">R{p.round}</span>}
                <Status status={p.status} tokens={p.tokens} />
              </div>
            </div>
            {(enriched.stance && (hasConsensus || p.stance)) && (<div className={`stance ${enriched.kind || "maj"}`}>{enriched.stance}</div>)}
            <div className="col-body">
              {p.text ? <p className={p.status === "error" ? "err" : ""}>{p.text}</p> : <p className="placeholder">{p.status === "thinking" ? "▌" : "awaiting"}</p>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Verdict({ consensus, conf1, judging }) {
  return (
    <section className={`verdict ${consensus?.disagreement ? "split" : "agree"}`}>
      <Ring value={consensus?.confidence ?? null} judging={judging} />
      <div className="vbody">
        <div className="vtop">
          <span className="vlabel">PANEL VERDICT{consensus?.phase === "final" ? ` · AFTER ${consensus.roundsRun} ROUND${consensus.roundsRun > 1 ? "S" : ""}` : ""}</span>
          {consensus && (
            <span className={`agreepill ${consensus.disagreement ? "split" : ""}`}>{consensus.agree_count}/{consensus.total} agree {consensus.disagreement ? "· split" : "· consensus"}</span>
          )}
          {consensus?.phase === "final" && conf1 != null && conf1 !== consensus.confidence && (
            <span className="confmove">confidence {conf1} → <b>{consensus.confidence}</b></span>
          )}
        </div>
        <p className="vtext">{consensus ? consensus.verdict : "Adjudicating the panel…"}</p>
        {consensus?.disagreement && consensus?.dissent && (<div className="dissent"><span className="dlabel">DISSENT</span> {consensus.dissent}</div>)}
      </div>
    </section>
  );
}

function TurnCard({ turn, onOpen }) {
  const vv = computeVerdictView(turn.consensus);
  const c = turn.consensus;
  return (
    <div className="turn">
      <div className="userbubble">{turn.question}</div>
      <div className="turncard">
        <div className="tc-models">
          {turn.answers.map((a, i) => {
            const enriched = { ...a, stance: a.stance ?? vv[i]?.stance, kind: a.kind ?? vv[i]?.kind };
            return (
              <button className="tc-chip" key={i} onClick={() => onOpen(enriched)} title="Open answer">
                <span className="tc-dot" style={{ background: a.color }} />
                {a.label}
                {enriched.kind && <span className={`tc-stance ${enriched.kind}`} />}
              </button>
            );
          })}
        </div>
        {c && (
          <div className={`tc-verdict ${c.disagreement ? "split" : "agree"}`}>
            <span className="tc-conf">{c.confidence}</span>
            <div className="tc-vbody">
              <div className="tc-vtop"><span className={`agreepill ${c.disagreement ? "split" : ""}`}>{c.agree_count}/{c.total} {c.disagreement ? "· split" : "· consensus"}</span></div>
              <p className="tc-vtext">{c.verdict}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Status({ status, tokens }) {
  if (status === "done") return <span className="st done">{tokens != null ? `${tokens} tok` : "done"}</span>;
  if (status === "error") return <span className="st err">error</span>;
  if (status === "thinking") return <span className="st think"><span className="lv" /> streaming</span>;
  return <span className="st idle">idle</span>;
}

function Ring({ value, judging }) {
  const v = value ?? 0;
  const r = 33;
  const cc = 2 * Math.PI * r;
  const off = cc * (1 - v / 100);
  return (
    <div className="ring">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r={r} stroke="#e7e7e0" strokeWidth="8" fill="none" />
        {!judging && (
          <circle cx="45" cy="45" r={r} stroke="#15141b" strokeWidth="8" fill="none" strokeLinecap="round"
            strokeDasharray={cc} strokeDashoffset={off} transform="rotate(-90 45 45)" style={{ transition: "stroke-dashoffset .8s ease" }} />
        )}
      </svg>
      <div className="ring-c">
        {judging ? <span className="ring-spin">◍</span> : <span className="num">{v}</span>}
        {!judging && <span className="ring-u">conf</span>}
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  async function doCopy() {
    const t = text || "";
    let ok = false;
    try {
      await navigator.clipboard.writeText(t);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.focus(); ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1400); }
  }
  return (
    <button className="copy-btn" onClick={doCopy} title="Copy reply">{copied ? "Copied" : "Copy"}</button>
  );
}

function fmt(n) {
  if (n == null) return "—";
  if (n < 0.01) return "$" + n.toFixed(6);
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}
