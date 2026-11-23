import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK_REFUSES_TOOL_CALL = 2;
const PENDING_LINE = "inbox.sh";

const claudeHooks = (event, keep = () => true) => () =>
  JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8")).hooks[event]
    .flatMap((group) => group.hooks)
    .filter((h) => keep(h.command));
const isPendingLine = (command) => command.includes(PENDING_LINE);

function lastReply(transcriptPath) {
  try {
    const steps = readFileSync(transcriptPath, "utf8").split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    return steps.findLast((s) => s.type === "PLANNER_RESPONSE" && s.content)?.content ?? "";
  } catch {
    return "";
  }
}

function asClaudeInput(event, d) {
  const cwd = d.cwd || d.workspacePaths?.[0] || "";
  return {
    hook_event_name: event,
    session_id: d.conversationId,
    cwd,
    transcript_path: d.transcriptPath,
    prompt: d.lastUserInput ?? "",
    tool_name: "Bash",
    tool_input: { command: d.toolCall?.args?.CommandLine ?? "" },
    ...(event === "Stop" && { last_assistant_message: lastReply(d.transcriptPath), stop_hook_active: d.executionNum > 0 }),
  };
}

function contextFrom(stdout) {
  const text = stdout.trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    return j.hookSpecificOutput?.additionalContext ?? j.systemMessage ?? "";
  } catch {
    return text;
  }
}

const injectSteps = (runs) => {
  const context = runs.map((r) => contextFrom(r.stdout)).filter(Boolean).join("\n\n");
  return context ? { injectSteps: [{ systemMessage: { systemMessage: context } }] } : {};
};

const gate = (runs) => {
  const refused = runs.find((r) => r.status === HOOK_REFUSES_TOOL_CALL);
  if (refused) return { decision: "deny", reason: refused.stderr.trim() };
  const warnings = runs.map((r) => contextFrom(r.stdout)).filter(Boolean);
  return warnings.length ? { decision: "allow", reason: warnings.join("\n") } : { decision: "allow" };
};

const continueWhenBlocked = (runs) => {
  for (const r of runs) {
    try {
      const j = JSON.parse(r.stdout);
      if (j.decision === "block") return { decision: "continue", reason: j.reason };
    } catch {}
  }
  return {};
};

const ROUTES = {
  SessionStart: { claudeEvent: "SessionStart", hooks: claudeHooks("SessionStart"), answer: injectSteps },
  PreInvocation: {
    claudeEvent: "UserPromptSubmit",
    onlyWhen: (d) => d.invocationNum === 0,
    hooks: () => [...claudeHooks("UserPromptSubmit")(), ...claudeHooks("Stop", isPendingLine)()],
    answer: injectSteps,
  },
  PreToolUse: { claudeEvent: "PreToolUse", hooks: claudeHooks("PreToolUse"), answer: gate },
  PostToolUse: { claudeEvent: "PostToolUse", hooks: claudeHooks("PostToolUse"), answer: () => ({}) },
  Stop: { claudeEvent: "Stop", hooks: claudeHooks("Stop", (c) => !isPendingLine(c)), answer: continueWhenBlocked },
};

const FAILSAFE = { PreToolUse: { decision: "allow" } };

function run(route, d) {
  if (route.onlyWhen && !route.onlyWhen(d)) return {};
  const claudeInput = asClaudeInput(route.claudeEvent, d);
  const input = JSON.stringify(claudeInput);
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: claudeInput.cwd };
  const runs = route.hooks().map((h) =>
    spawnSync("sh", ["-c", h.command], { input, env, encoding: "utf8", timeout: (h.timeout ?? 30) * 1000 }),
  );
  return route.answer(runs.map((r) => ({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" })));
}

const event = process.argv[2];
let answer = FAILSAFE[event] ?? {};
try {
  answer = run(ROUTES[event], JSON.parse(readFileSync(0, "utf8")));
} catch {}
process.stdout.write(JSON.stringify(answer) + "\n");
