import { test } from "node:test";
import assert from "node:assert/strict";
import { postAnswer, AnswerError, fetchBoard, fetchInbox } from "./api.ts";

test("answer preserves exact authority boundary and does not retry unknown outcomes", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ ok: false, unknown: true, out: "timeout" }),
      { status: 504 },
    );
  }) as typeof fetch;
  try {
    await assert.rejects(
      postAnswer(12, "选项A · 补充:证据", false),
      (e: unknown) => e instanceof AnswerError && e.unknown,
    );
    assert.deepEqual(calls, [
      {
        url: "/api/answer",
        body: { ask_id: 12, verdict: "选项A · 补充:证据", reject: false },
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test("HTTP 200 with ok:false is a failed answer", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, out: "CAS rejected" }), {
      status: 200,
    })) as typeof fetch;
  try {
    await assert.rejects(postAnswer(13, "打回理由", true), /CAS rejected/);
  } finally {
    globalThis.fetch = original;
  }
});

test("lost transport and unreadable responses leave the answer outcome unknown", async () => {
  const original = globalThis.fetch;
  try {
    for (const reply of [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => new Response("Bad Gateway", { status: 502 }),
    ]) {
      globalThis.fetch = reply as typeof fetch;
      await assert.rejects(
        postAnswer(14, "授权", false),
        (e: unknown) => e instanceof AnswerError && e.unknown,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("project scopes read URLs and all-projects omits the parameter", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url) => {
    urls.push(String(url));
    return new Response("{}");
  }) as typeof fetch;
  try {
    await fetchBoard({ since: "2026-09-01", until: "2026-09-02" }, "example-project");
    await fetchBoard(null, null);
    await fetchInbox("nawaban");
    assert.deepEqual(urls, [
      "/api/board?since=2026-09-01&until=2026-09-02&project=example-project",
      "/api/board",
      "/api/inbox?project=nawaban",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
