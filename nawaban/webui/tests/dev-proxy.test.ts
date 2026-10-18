import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";

test("the real Vite proxy forwards board reads and the board's write refusal", { timeout: 15000 }, async () => {
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
    process.env.NAWABAN_API_URL = `http://127.0.0.1:${ready.port}`;
    const { default: config } = await import("../vite.config.ts");
    vite = await createServer({ ...config, configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", server: { ...config.server, host: "127.0.0.1", port: 0 } });
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;

    const board = await fetch(`${origin}/api/board`);
    assert.equal(board.status, 200);
    const ids = ((await board.json()) as { columns: { tasks: { id: string }[] }[] })
      .columns.flatMap((column) => column.tasks.map((task) => task.id));
    assert.deepEqual(ids, ["PROXY-001"]);
    const task = await fetch(`${origin}/api/task?id=PROXY-001`);
    assert.equal(((await task.json()) as { title: string }).title, "Proxy fixture task");

    const write = await fetch(`${origin}/api/task?id=PROXY-001`, { method: "POST", body: "{}" });
    assert.equal(write.status, 405);
  } finally {
    if (previousTarget === undefined) delete process.env.NAWABAN_API_URL;
    else process.env.NAWABAN_API_URL = previousTarget;
    await vite?.close();
    lines.close();
    backend.kill();
    await backendExit;
  }
});
