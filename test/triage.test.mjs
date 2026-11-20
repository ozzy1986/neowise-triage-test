import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, triage } from "../app.mjs";

const quiet = { warn() {}, error() {} };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

let server;
let baseUrl;

before(async () => {
  server = createApp({ log: quiet });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

// Model failures: the API must answer 200 manual_review, never a broken result.
for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${marker} -> manual_review`, async () => {
    const { status, data } = await post({ text: `Где мой заказ? ${marker}` });
    assert.equal(status, 200);
    assert.deepEqual(data, MANUAL_REVIEW);
  });
}

test("model timeout -> manual_review within the 300 ms budget", async () => {
  const started = performance.now();
  const { status, data } = await post({ text: "Где доставка? [timeout]" });
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(data, MANUAL_REVIEW);
  assert.ok(elapsed < 600, `took ${Math.round(elapsed)} ms, mock sleeps 1200 ms`);
});

test("timeout holds even if the model ignores the abort signal", async () => {
  const neverEnds = () => new Promise(() => {});
  const started = performance.now();
  const result = await triage("текст", { classify: neverEnds, timeoutMs: 50, log: quiet });
  assert.deepEqual(result, MANUAL_REVIEW);
  assert.ok(performance.now() - started < 500);
});

for (const [name, body] of [
  ["empty string", { text: "" }],
  ["whitespace only", { text: "   \n\t" }],
  ["missing text", {}],
  ["number", { text: 42 }],
  ["null body", "null"],
  ["array body", "[]"],
  ["malformed JSON", "{\"text\": "],
]) {
  test(`invalid input (${name}) -> 400`, async () => {
    const { status, data } = await post(body);
    assert.equal(status, 400);
    assert.deepEqual(data, { status: "invalid_input" });
  });
}

for (const [text, topic] of [
  ["Когда будет доставка?", "delivery"],
  ["Какая цена у тарифа?", "pricing"],
  ["Здравствуйте!", "other"],
]) {
  test(`valid request -> ready with topic ${topic}`, async () => {
    const { status, data } = await post({ text });
    assert.equal(status, 200);
    assert.equal(data.status, "ready");
    assert.equal(data.topic, topic);
    assert.equal(typeof data.draft, "string");
    assert.ok(data.draft.trim().length > 0);
  });
}
