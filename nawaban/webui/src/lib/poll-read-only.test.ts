import { test } from "node:test";
import assert from "node:assert/strict";
import { pollReadOnly } from "./poll-read-only.ts";

test("task views refresh after 30 seconds and recover after a failed read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const values: number[] = [];
  const errors: unknown[] = [];
  const stop = pollReadOnly(async () => {
    calls++;
    if (calls === 2) throw new Error("offline");
    return calls;
  }, (v) => values.push(v), (e) => errors.push(e));
  await Promise.resolve();
  assert.deepEqual(values, [1]);
  t.mock.timers.tick(29_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(errors.length, 1);
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.deepEqual(values, [1, 3]);
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 3);
});

test("leaving a view discards its in-flight response and schedules no more reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const values: string[] = [];
  let resolve!: (value: string) => void;
  let calls = 0;
  const stop = pollReadOnly(() => {
    calls++;
    return new Promise<string>((done) => { resolve = done; });
  }, (v) => values.push(v), assert.fail);
  t.mock.timers.tick(90_000);
  assert.equal(calls, 1);
  stop();
  resolve("stale");
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.deepEqual(values, []);
  assert.equal(calls, 1);
});
