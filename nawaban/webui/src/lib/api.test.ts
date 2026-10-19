import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBoard, fetchProjects, fetchTask } from "./api.ts";

async function requests(run: () => Promise<unknown>) {
  const original = globalThis.fetch;
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return new Response("{}");
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

test("project scopes read URLs and all-projects omits the parameter", async () => {
  const calls = await requests(async () => {
    await fetchBoard({ since: "2026-09-01", until: "2026-09-02" }, "example-project");
    await fetchBoard(null, null);
    await fetchBoard(null, "");
    await fetchBoard(null, "all");
  });
  assert.deepEqual(calls.map((c) => c.url), [
    "/api/board?since=2026-09-01&until=2026-09-02&project=example-project",
    "/api/board",
    "/api/board?unassigned=1",
    "/api/board?project=all",
  ]);
});

test("every request the page makes is a read", async () => {
  const calls = await requests(async () => {
    await fetchProjects();
    await fetchTask("A/B C");
  });
  assert.deepEqual(calls, [
    { url: "/api/projects", method: "GET" },
    { url: "/api/task?id=A%2FB%20C", method: "GET" },
  ]);
});

test("an HTTP error is a failed read", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(fetchTask("NOPE"), /HTTP 404/);
  } finally {
    globalThis.fetch = original;
  }
});
