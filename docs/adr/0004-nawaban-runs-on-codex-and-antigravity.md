# nawaban runs on Codex and Antigravity through the same CLI and skill, a hook adapter per agent, and dispatch that names the agent

Status: proposed (11-24, NAWABAN-AGENTS-01). The decision-maker chose to support Codex and Gemini, Gemini meaning Google Antigravity (NAWABAN-AGENTS, 11-24). Claude Code stays the default, and the board's data format does not change.

nawaban has three parts, and each lands differently on each agent:

- **记账** is the board CLI plus the `nawaban` skill. It runs on any agent that can run a shell command and read a SKILL.md.
- **编排者** is the declaration, the pending line, and the web answers read back. It rests on hooks.
- **派活** is `nawaban dispatch`, which starts `claude` today.

We keep one plugin tree, one CLI and one skill for all three agents. The identity rule changes so that each agent's own session variable comes first. Codex reuses `hooks/hooks.json` as written. Antigravity gets a small adapter that translates its hook JSON to the shape our scripts already read. `dispatch` takes `--agent claude|codex|agy`. On an agent without the hook a part needs, the orchestrator runs `nawaban page` at the start of every turn instead, as its rules say.

"Gemini" here means the Antigravity CLI `agy`, not Gemini CLI. Free and Google AI Pro/Ultra users moved to Antigravity CLI on 2026-06-18, and Gemini CLI now serves only Code Assist enterprise customers [A1][A2].

Labels used below: **docs** is the vendor's documentation, **here** was run on this machine on 11-24, **inferred** is our reading, and **untested** means nobody ran it.

## What each agent offers, as found on 11-24

Versions: Claude Code is what this plugin already targets. Codex is `codex-cli 0.171.0` (release `rust-v0.171.0`, 2026-11-20) [C0]. Antigravity is App `v2.34.0` and CLI `v1.5.12`, the newest entries on its changelog on 11-24 [A3]. Antigravity is not installed here (no `agy` or `antigravity` on PATH, nothing in `/Applications`), so every Antigravity line is docs, untested.

| What nawaban uses in Claude Code | Codex 0.171.0 | Antigravity App 2.34.0 / CLI 1.5.12 |
| --- | --- | --- |
| Plugin: `.claude-plugin/plugin.json`, `marketplace.json` | Manifest `plugin.json` at the root, with `.codex-plugin/plugin.json` kept for older packages. Marketplace `.agents/plugins/marketplace.json`, or `.claude-plugin/marketplace.json` for compatibility. `codex plugin marketplace add` then `codex plugin add` (docs [C1]; here: `nawaban@nawaban` is installed from a local marketplace). | Manifest `plugin.json` or `.antigravity-plugin/plugin.json`. Components are `skills/`, `agents/`, `rules/`, a root `hooks.json` and `mcp_config.json`. `agy plugin install <dir or GitHub URL>`, and `agy plugin import claude` exists (docs [A4][A5]). |
| Skills: `skills/*/SKILL.md` | `.agents/skills` from cwd up to the repository root, `~/.agents/skills`, and a plugin's `skills/`. The model picks one by its description, or the user names it with `$skill` (docs [C2]). | Agent Skills standard. Workspace `.agents/skills/`, global `~/.gemini/config/skills/`. In the CLI each skill is a `/<skill>` command, and a plugin's skill is `<plugin>:<skill>` (docs [A6][A7]). |
| Slash command `/nawaban:orchestrator` (a skill with `disable-model-invocation`) | Custom prompts are deprecated in favour of skills. A plugin's `commands/` is migrated into skills (docs [C3]; source [C4]). | Workflows are deprecated in favour of skills (docs [A7]). |
| `AGENTS.md` / `CLAUDE.md` | `AGENTS.md`, global then root to cwd, 32 KiB cap (docs [C5]). | `AGENTS.md` or `GEMINI.md` in each directory up to the root, `.agents/rules/*.md`, and global `~/.gemini/AGENTS.md` (docs [A8]). |
| Hook input `session_id` on stdin | Same field, plus `turn_id` and `cwd` (docs [C6]; here). | `conversationId` (docs [A9]). |
| SessionStart, UserPromptSubmit: stdout or `additionalContext` reaches the model | Same events, same effect (docs [C6]; here: SessionStart `additionalContext` reached the model). | `SessionStart`, and `PreInvocation` carrying `lastUserInput`. Both answer with `injectSteps` (docs [A9]). |
| PreToolUse on `Bash`, deny | `Bash` matcher, `permissionDecision: "deny"` or exit 2 (docs [C6]; here: a PreToolUse hook blocked `echo forbidden-xyz`). | Matcher `run_command`, the command in `toolCall.args.CommandLine`, `decision: "deny"`. A non-zero exit is logged and the call goes ahead (docs [A9][A4]). |
| PostToolUse | Yes (docs [C6]). | Yes, output `{}` only (docs [A9]). |
| Stop: block with a reason, and a line shown to the person | `decision: "block"` continues with the reason, and the next call has `stop_hook_active`. `systemMessage` is shown as a warning (docs [C6]; here: block, untested: `systemMessage` display). | `decision: "continue"` puts `reason` before the model. No documented line for the person on Stop (docs [A9]). |
| Hooks in a plugin | `hooks/hooks.json`, with `CLAUDE_PLUGIN_ROOT` given for compatibility. Each hook must be trusted by hash in `/hooks`, again after any change (docs [C1][C6]). Here: `~/.codex/config.toml` has trust entries `nawaban@nawaban:hooks/hooks.json:pre_tool_use…`, `:session_start…` and `:stop…`, so Codex reads this plugin's hooks file. Untested: whether they run and whether `onFailure` is accepted. | Root `hooks.json` in Antigravity's own shape (docs [A4]). |
| Session id in a shell command's environment (`CLAUDE_CODE_SESSION_ID`) | `CODEX_THREAD_ID`, equal to the hooks' `session_id` (source [C7]; here). | None documented (docs [A9]); untested. |
| Start a session with a first prompt (`claude --model m "<brief>"`) | `codex -m m -C dir "<brief>"`. The TUI turns the prompt into the session's first user message, and submits it unless something suppresses that (source [C8]: `create_initial_user_message`, `set_initial_user_message_submit_suppressed`; untested live). `codex exec` runs headless (docs [C9]). | `agy -i "<brief>"` opens an interactive session with that prompt. `agy -p` is headless, and `--output-format json` returns `conversation_id` (docs [A10][A11]). |
| Running `node <cli>` | Default sandbox `workspace-write`: no network and no writes outside the workspace (here, see below). | Permission rules such as `command(node …)` in `permissions.allow`, a Seatbelt sandbox on macOS, `agentMode` auto by default in the CLI (docs [A12]). |

## Tried on this machine

The acceptance asks for one minimal run where the agent is installed. Codex is installed, so it ran here. Antigravity is not installed, so that part does not apply to it here.

Setup: a temporary board (`NAWABAN_BOARD_DIR=<scratchpad>/board`, `NAWABAN_BOARD_PORT=4199`, with `BOARD_TOKEN` and `BOARD_URL` unset) and two tasks, `AGTEST-01` and `AGTEST-02`. Each run was `codex exec --ephemeral --skip-git-repo-check -s workspace-write -C <scratchpad>/cx "<prompt>"`. The prompt said: read `skills/nawaban/SKILL.md`, claim the task, record a 进展同步 note, and `show` it. Output is trimmed to the commands and results.

**Run 1. `network_access=true`, `CLAUDE_CODE_SESSION_ID` unset: 记账 works, and claim trips the sandbox.**

```text
OpenAI Codex v0.171.0
sandbox: workspace-write [workdir, /tmp, $TMPDIR] (network access enabled)

$ NAWABAN_OWNER=codex-agtest-01 node <cli> claim AGTEST-01
 exited 1:
error: Failed to claim task #2.
  EPERM: operation not permitted, open '~/.config/board/claims/<hash>.json.<pid>.tmp'

$ NAWABAN_OWNER=codex-agtest-01 node <cli> event AGTEST-01 --kind note --body '已完成：codex 最小验证 / 下一步：无 / 卡点：无'
 succeeded: 10

$ node <cli> show AGTEST-01
#2  claimed    AGTEST-01  codex 最小验证
  holder      codex-agtest-01 via <user> · until 2026-11-23T20:08:38.143Z
  latest      <user> · 2026-11-23T19:09:06.781Z  已完成：codex 最小验证 / 下一步：无 / 卡点：无
```

The model set `NAWABAN_OWNER` itself from the skill's identity line. The claim landed on the board, but the CLI exited 1, because the lease file under `~/.config/board/claims/` is outside the sandbox's writable roots. Lease renewal reads that file.

**Run 2. Same, `CLAUDE_CODE_SESSION_ID` inherited from the Claude Code session that started Codex: the Codex session writes as that Claude Code session.**

```text
$ node <cli> show AGTEST-02
#4  claimed    AGTEST-02  codex 身份泄漏
  holder      cc-4889c8a6 via <user> · until 2026-11-23T20:08:42.029Z
```

`cc-4889c8a6` is the Claude Code session that ran `codex exec`. `profile()` (`board/src/tasks.ts:27`) takes `CLAUDE_CODE_SESSION_ID` first, and Codex passes the parent's environment through to its commands. A worker that `hc run` starts gets its environment from Herdr, not from the session that ran `dispatch` (inferred, untested).

**Run 3. Default sandbox, no `network_access`: the CLI cannot reach the board.**

```text
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
$ node <cli> show AGTEST-01
 exited 1:
error: the board didn't answer: fetch failed
```

## How each part lands

### 记账

- **Claude Code**: unchanged.
- **Codex**: runs today with two settings. `[sandbox_workspace_write] network_access = true` lets the CLI reach `127.0.0.1` (here, runs 1 and 3). `~/.config/board` must be among `writable_roots` so that claim and renew can write their lease (here, run 1). Identity comes from `CODEX_THREAD_ID` as `cx-<first 8>`, read before `CLAUDE_CODE_SESSION_ID`, which fixes run 2.
- **Antigravity**: the skill loads from the plugin's `skills/` (docs). Allow `command(node <cli>)` in `permissions.allow` (docs). There is no session variable, so a SessionStart hook injects `NAWABAN_OWNER=agy-<first 8 of conversationId>` as a step, and the skill's existing line tells the model to set `NAWABAN_OWNER` (inferred, untested).
- **Degraded**: anywhere hooks don't run, `NAWABAN_OWNER` set by hand, as `docs/install.md` already says for Codex.

### 编排者

- **Codex**: `hooks/hooks.json` is read as written (`CLAUDE_PLUGIN_ROOT` is provided, `session_id` is on stdin, the event names match). The declaration hook matches the prompt `/nawaban:orchestrator*`. On Codex the owner names the skill as `$orchestrator` (or `$nawaban:orchestrator`, untested), so the hook also matches that form. The pending line goes out as `systemMessage` (docs; display untested). The owner must trust the hooks in `/hooks` after each plugin update (docs). That is an install step, and a hook left untrusted fails silently into the degraded mode.
- **Antigravity**: one adapter, `hooks/agy.mjs`, listed in the root `hooks.json` for `SessionStart`, `PreInvocation`, `PreToolUse` (`run_command`) and `Stop`. It rewrites `conversationId` to `session_id`, `lastUserInput` to `prompt`, and `toolCall.args.CommandLine` to `tool_input.command`. It runs the existing script and maps the reply back: context to `injectSteps`, deny to `decision: "deny"`, block to `decision: "continue"`. A failing adapter must print `{}`, because Antigravity lets the call through on a non-zero exit (docs). The pending line has no documented place on Stop, so it reaches the model at the next prompt through `PreInvocation`, as `page-writes.sh` already does in Claude Code. It does not reach the person directly.
- **Degraded** (no hooks, or untrusted): the `nawaban` skill already tells the orchestrator to run `nawaban index` at start. It gains one line: on an agent without the hooks, run `nawaban page --project <p>` and `nawaban inbox` before each reply. The ask guard has no fallback; the rule "record the ask, then ask" is all that holds it.

### 派活

- `board/src/dispatch.ts` starts `hc run … claude --model <m> <brief>`, and the brief opens with `/pstack:poteto-mode`. Both are Claude Code's. `--agent` picks a row from one table: `claude` → `claude --model m <brief>`, `codex` → `codex -m m <brief>`, `agy` → `agy -i <brief>` (plus `--model` if given). The `/pstack:poteto-mode` prefix belongs to the `claude` row, and `--model` has no default for the other rows. Herdr still runs the terminal and carries the reports (`hc send`), so the report protocol does not change.
- Untested: whether `codex "<brief>"` submits on its own in a fresh worktree, or stops at Codex's trust prompt for a new directory first.

### 装

- **Codex**: what `docs/install.md` says today, plus the two sandbox settings and trusting the hooks in `/hooks`. Codex copies the plugin into its cache, so `codex plugin add` again after each pull (docs; here, the cached copy is `0.2.0` while the checkout is `0.3.0`).
- **Antigravity**: `.antigravity-plugin/plugin.json` and a root `hooks.json`, then `agy plugin install <checkout>` and the `permissions.allow` rule.
- `README.md` and `docs/install.md` say the plugin "registers no hooks". That is stale: `hooks/hooks.json` registers SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop hooks.

## Considered Options

- **One plugin tree with per-agent manifests and a hook adapter (chosen)**: the CLI, the skill and the hook scripts stay single, and only the outermost JSON differs per agent.
- **A plugin per agent, generated from one source**: rejected, a build step for three manifests and one adapter.
- **`agy plugin import claude` instead of our own Antigravity manifest**: rejected for now. What it does with `hooks.json` is not documented, and an import is a copy that goes stale on every pull.
- **An MCP server instead of CLI plus skill**: rejected, all three agents run shell commands, and the CLI is already the one writer.
- **Gemini CLI 0.65.0, installed here, as "Gemini"**: rejected, it serves only enterprise Code Assist customers now [A1]. It shares `~/.gemini/GEMINI.md` and skills with Antigravity but not hooks or MCP [A13].
- **Identity from `NAWABAN_OWNER` only on Codex (today)**: rejected, `CLAUDE_CODE_SESSION_ID` wins whenever it leaks in (run 2), and `CODEX_THREAD_ID` is per session at no cost.

## Consequences

- `profile()` reads `CODEX_THREAD_ID` before `CLAUDE_CODE_SESSION_ID`. The reverse case, Claude Code started inside Codex, then writes as the Codex session. We take that because the case seen here (Codex inside Claude Code, for example `codex:rescue`) is the common one.
- Codex users must turn on network access for `workspace-write` and add `~/.config/board` to `writable_roots`, which widens their sandbox.
- Hook scripts stay in Claude Code's JSON shape. Antigravity pays a translation step, and a hook protocol change there touches only `hooks/agy.mjs`.
- On Antigravity the person sees no pending line after each reply. The orchestrator sees it at the next prompt, and the web page or the Herdr panel shows it to the person.

## Open for the decision-maker

- Support Gemini CLI (enterprise Code Assist) as well? The default is no, per the spec's "Gemini 指 Antigravity".
- Installing and signing in to Antigravity here is the first Antigravity task's precondition. Only the decision-maker can do it.

## Suggested tasks

In order. Each is a child of NAWABAN-AGENTS. None is created yet.

1. **NAWABAN-AGENTS-02 身份按 agent 取，Codex 不再冒用 Claude Code 的会话**. Blocked by nothing. Acceptance: `profile()` reads `CODEX_THREAD_ID` (→ `cx-<8>`), then `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`. A test covers the order. Run 2 above, repeated on a temporary board, shows a `cx-` holder. `GLOSSARY.md` **Session** and the skill's identity line say so.
2. **NAWABAN-AGENTS-03 Codex 默认装法下记账跑通**. Blocked by nothing. Acceptance: `install.sh` and `docs/install.md` set `network_access` and `writable_roots` for Codex, and fix "registers no hooks" in `README.md` and `docs/install.md`. Runs 1 and 3 repeated on a temporary board give claim exit 0, the lease file written, and the note recorded.
3. **NAWABAN-AGENTS-04 Codex 上的编排者**. Blocked by 02 and 03. Acceptance: in an interactive Codex session with the plugin's hooks trusted, naming the orchestrator skill records `<board dir>/orchestrator/<project>`. A pending ask shows the pending line after a reply. A reply asking for a decision with no ask recorded is sent back. Any part that cannot work is written into the `nawaban` skill as the degraded rule.
4. **NAWABAN-AGENTS-05 dispatch --agent claude|codex|agy**. Blocked by 02. Acceptance: one argv table in `dispatch.ts`, a test per row, `claude` unchanged by default. A real `dispatch <key> --agent codex` on a temporary board starts a Codex worker in Herdr whose brief is submitted and whose claim shows a `cx-` holder.
5. **NAWABAN-AGENTS-06 Antigravity 安装与记账**. Blocked by 02, and by the decision-maker installing and signing in to `agy`. Acceptance: `.antigravity-plugin/plugin.json`, `agy plugin install` of the checkout, and the minimal run above repeated with `agy -p`, with output on the task. Every Antigravity "untested" line in this ADR becomes "here" or is corrected.
6. **NAWABAN-AGENTS-07 Antigravity 上的编排者（hook 适配）**. Blocked by 04 and 06. Acceptance: `hooks/agy.mjs` and the root `hooks.json`, with tests that feed recorded Antigravity hook inputs and check the mapped outputs. The same three checks as 04, run in `agy`.

## Sources

Read 11-24. Vendor docs pages carry no version, so each is pinned to the product version current that day.

- [C0] Codex release `rust-v0.171.0`, 2026-11-20: https://github.com/openai/codex/releases/tag/rust-v0.171.0
- [C1] Codex, build plugins: https://developers.openai.com/codex/plugins/build
- [C2] Codex, skills: https://learn.chatgpt.com/docs/build-skills
- [C3] Codex, custom prompts: https://learn.chatgpt.com/docs/custom-prompts
- [C4] Codex source, `commands/` to skills: https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core-plugins/src/command_migration/plugin.rs
- [C5] Codex, AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- [C6] Codex, hooks: https://learn.chatgpt.com/docs/hooks
- [C7] Codex source, shell environment: https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/protocol/src/shell_environment.rs
- [C8] Codex source, initial prompt: https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/tui/src/app/startup.rs
- [C9] Codex, CLI commands: https://learn.chatgpt.com/docs/developer-commands?surface=cli
- [A1] Gemini CLI README: https://github.com/google-gemini/gemini-cli
- [A2] Google for Developers blog, transitioning Gemini CLI to Antigravity CLI: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- [A3] Antigravity changelog (App v2.34.0, CLI v1.5.12): https://antigravity.google/docs/changelog
- [A4] Antigravity, build plugins: https://antigravity.google/docs/build-plugins
- [A5] Antigravity, plugins: https://antigravity.google/docs/plugins
- [A6] Antigravity, skills: https://antigravity.google/docs/skills
- [A7] Antigravity, workflows to skills: https://antigravity.google/docs/migration/workflows-to-skills
- [A8] Antigravity, rules: https://antigravity.google/docs/rules
- [A9] Antigravity, hooks: https://antigravity.google/docs/hooks
- [A10] Antigravity, getting started (CLI): https://antigravity.google/docs/getting-started?tab=cli
- [A11] Antigravity, headless CLI: https://antigravity.google/docs/cli/headless
- [A12] Antigravity, permissions: https://antigravity.google/docs/permissions
- [A13] Antigravity, migrating from Gemini CLI: https://antigravity.google/docs/cli/gcli-migration
