// POST /api/finetune — drive real fine-tuning (training) jobs on Nebius from the app.
// Verified contract: upload a JSONL file (purpose "fine-tune"), then create a job with
// {model, training_file}. Poll the job for status + the resulting fine_tuned_model id.
//   action "create" {model, jsonl}  -> uploads data, starts the job
//   action "status" {jobId}         -> current status + fine-tuned model id when done
//   action "list"                   -> recent jobs (they live server-side on Nebius)
//   action "cancel" {jobId}         -> stop a running job

import { getClient } from "../../../lib/nebius";
import { toFile } from "openai";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const client = getClient();
  if (!client) return Response.json({ ok: false, error: "NEBIUS_API_KEY not set" }, { status: 400 });

  let body = {};
  try { body = await req.json(); } catch {}
  const action = body.action;

  try {
    if (action === "create") {
      const model = String(body.model || "").trim();
      const jsonl = String(body.jsonl || "").trim();
      if (!model) return Response.json({ ok: false, error: "Pick a base model to fine-tune." });
      const lines = jsonl.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 1) return Response.json({ ok: false, error: "Training data is empty. Add at least one example." });
      // validate every line is {"messages":[...]} so the upload doesn't fail mid-way
      for (let i = 0; i < lines.length; i++) {
        try {
          const o = JSON.parse(lines[i]);
          if (!Array.isArray(o.messages) || !o.messages.length) throw new Error("no messages[]");
        } catch {
          return Response.json({ ok: false, error: `Line ${i + 1} isn't valid — each line must be {"messages":[{"role":...,"content":...}, ...]}` });
        }
      }
      const file = await client.files.create({
        file: await toFile(Buffer.from(lines.join("\n") + "\n"), "quorum-train.jsonl"),
        purpose: "fine-tune",
      });
      const job = await client.fineTuning.jobs.create({ model, training_file: file.id });
      return Response.json({ ok: true, jobId: job.id, status: job.status, model: job.model, fileId: file.id, examples: lines.length });
    }

    if (action === "status") {
      const job = await client.fineTuning.jobs.retrieve(String(body.jobId || ""));
      return Response.json({
        ok: true, jobId: job.id, status: job.status, model: job.model,
        fineTuned: job.fine_tuned_model || null,
        trainedTokens: job.trained_tokens || null,
        error: job.error?.message || null,
      });
    }

    if (action === "list") {
      const jobs = await client.fineTuning.jobs.list({ limit: 20 });
      return Response.json({
        ok: true,
        jobs: (jobs.data || []).map((j) => ({
          jobId: j.id, status: j.status, model: j.model,
          fineTuned: j.fine_tuned_model || null, created: j.created_at || null,
        })),
      });
    }

    if (action === "cancel") {
      const job = await client.fineTuning.jobs.cancel(String(body.jobId || ""));
      return Response.json({ ok: true, jobId: job.id, status: job.status });
    }

    return Response.json({ ok: false, error: "unknown action" });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.error?.message || e?.message || e) }, { status: 200 });
  }
}
