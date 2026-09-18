import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";

function send(url: string, headers: Record<string, string | string[]>, method = "POST") {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = method === "POST" ? JSON.stringify(url.endsWith("/api/captures") ? { id: "fixture", content: "An idea" } : { ask_id: 1, verdict: "Test only" }) : "";
    const rawHeaders = Object.entries({ Host: new URL(url).host, "Content-Length": String(Buffer.byteLength(payload)), ...headers })
      .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item]));
    const req = request(url, { method, headers: rawHeaders }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the real Vite proxy forwards only same-origin browser answers to the board handler", { timeout: 15000 }, async () => {
  const backend = spawn(process.env.PYTHON || "python3", ["-u", fileURLToPath(new URL("fixtures/dev-proxy-backend.py", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
  const backendExit = once(backend, "exit");
  const lines = createInterface({ input: backend.stdout });
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const previousTarget = process.env.NAWABAN_API_URL;
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line) as { port: number }),
      backendExit.then(([code]) => { throw new Error(`Backend fixture exited: ${code}`); }),
    ]);
    const target = `http://127.0.0.1:${ready.port}`;
    process.env.NAWABAN_API_URL = target;
    const { default: config } = await import("../vite.config.ts");
    vite = await createServer({ ...config, configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", server: { ...config.server, host: "127.0.0.1", port: 0 } });
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    const json = { "Content-Type": "application/json" };
    for (const path of ["/api/answer", "/api/captures"]) {
    const valid = await send(`${origin}${path}`, { ...json, Origin: origin, "Sec-Fetch-Site": "same-origin" });
    assert.equal(valid.status, 200, valid.body);
    for (const headers of [
      { Origin: "http://attacker.invalid" },
      { Origin: "null" },
      {},
      { Origin: target },
      { Origin: origin, "Sec-Fetch-Site": "cross-site" },
      { Origin: [origin, "null"] },
      { Origin: origin, Host: [new URL(origin).host, "attacker.invalid"] },
    ] as Record<string, string | string[]>[]) {
      const rejected = await send(`${origin}${path}`, { ...json, ...headers });
      assert.equal(rejected.status, 403, JSON.stringify({ headers, ...rejected }));
    }
    }
    const reads = await send(`${origin}/api/review-requests`, {}, "GET");
    assert.equal(reads.status, 200);
    const observed = JSON.parse(reads.body);
    assert.equal(observed.calls, 2);
    assert.equal(observed.requests.length, 2);
    assert.equal(observed.requests[0].origin, target);
    assert.equal(observed.requests[0].host, new URL(target).host);
    assert.equal((await send(`${target}/api/answer`, json)).status, 200, "Direct loopback CLI remains supported");
  } finally {
    if (previousTarget === undefined) delete process.env.NAWABAN_API_URL;
    else process.env.NAWABAN_API_URL = previousTarget;
    await vite?.close();
    lines.close();
    backend.kill();
    await backendExit;
  }
});
