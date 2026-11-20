import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify as defaultClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MAX_BODY_BYTES = 64 * 1024;

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

class InputError extends Error {}

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InputError("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("malformed JSON");
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new InputError("text must be a non-empty string");
  }
  return text;
}

// Runs the model with a hard deadline. The signal lets a cooperative model stop
// early; the race guarantees the deadline even if the model ignores the signal.
async function classifyWithTimeout(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Returns {topic, draft} only if the model output is fully usable, otherwise null.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const { topic, draft } = data;
  if (!ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

export async function triage(text, { classify = defaultClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console } = {}) {
  let raw;
  try {
    raw = await classifyWithTimeout(classify, text, timeoutMs);
  } catch (error) {
    log.warn(`[triage] manual_review: ${error.message}`);
    return MANUAL_REVIEW;
  }
  const result = parseModelOutput(raw);
  if (!result) {
    log.warn("[triage] manual_review: unusable model output");
    return MANUAL_REVIEW;
  }
  return { status: "ready", ...result };
}

export function createApp(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      json(response, 200, await triage(text, options));
    } catch (error) {
      if (error instanceof InputError) return json(response, 400, INVALID_INPUT);
      (options.log ?? console).error("[triage] server_error:", error);
      json(response, 500, { status: "server_error" });
    }
  });
}
