# Installation

The short path: paste this into Claude Code or Codex, in the project that should get a board.

```text
Install nawaban by following https://github.com/victorGPT/nawaban/blob/main/docs/install.md and create a board in this project.
```

The agent follows the next section. The sections after it are the same install by hand, and the details behind it.

## For the agent doing the install

Run these steps in order. Each one is safe to run again. Stop and tell the user if a step fails.

1. Check that `git` and `python3` exist and that `python3 --version` is 3.9 or newer.
2. Put nawaban at `~/nawaban`. If that directory exists and is a nawaban checkout, run `git -C ~/nawaban pull --ff-only`; otherwise run `git clone https://github.com/victorGPT/nawaban ~/nawaban`.
3. Install the plugin.
   - Claude Code: `claude plugin marketplace add ~/nawaban`, then `claude plugin install nawaban@nawaban`.
   - Codex: add the marketplace and plugin entries shown under [Plugin install](#plugin-install) to `~/.codex/config.toml` with `source = "<absolute path of ~/nawaban>"`, then run `codex plugin add nawaban@nawaban`. Also set `NAWABAN_OWNER` to a stable name in the environment Codex runs commands in ([Session identity](#session-identity)).
4. In the user's project, create the board: `python3 ~/nawaban/nawaban/cli.py init`. It prints the board path, or says the board already exists.
5. Tell the user three things: the board path from step 4, that the `nawaban` skill loads in a new session, so they should start one, and that they see the board in the Herdr panel, which they install by following [Herdr panel](#herdr-panel).

Optional, for a person who wants to type commands: add `nawaban() { python3 ~/nawaban/nawaban/cli.py "$@"; }` to their shell profile, only if they ask.

## Plugin install

The same checkout is a Claude Code plugin and a Codex plugin. It ships one skill, `nawaban`, and registers no hooks, so there is nothing to trust or approve beyond installing it.

- **Claude Code:** `claude plugin marketplace add /path/to/nawaban`, then `claude plugin install nawaban@nawaban`. For a one-off session, `claude --plugin-dir /path/to/nawaban` also works. With this directory marketplace, Claude Code reads the plugin from the checkout; start a new session after pulling. If you also develop nawaban, point the marketplace at a separate clone that only follows `main`, so branch switches and uncommitted edits stay out of your sessions ([release and update](release.md)).
- **From GitHub:** `claude plugin marketplace add victorGPT/nawaban`, then `claude plugin install nawaban@nawaban`. Claude Code updates the plugin only when `version` in `.claude-plugin/plugin.json` changes: run `claude plugin marketplace update nawaban && claude plugin update nawaban@nawaban`, then start a new session ([release and update](release.md)).
- **Codex:** add the checkout as a local marketplace in `~/.codex/config.toml`, then install it. Codex copies the plugin into its cache, so run `codex plugin add` again after pulling.

  ```toml
  [marketplaces.nawaban]
  source_type = "local"
  source = "/path/to/nawaban"

  [plugins."nawaban@nawaban"]
  enabled = true
  ```

  ```sh
  codex plugin add nawaban@nawaban
  ```

For a local checkout, clone `https://github.com/victorGPT/nawaban` and replace `/path/to/nawaban` with its absolute path. Private repositories require GitHub access.

## Run from a checkout

Set `NAWABAN_HOME` to this checkout and define the CLI in your shell (no package installation required):

```sh
export NAWABAN_HOME="$(pwd)"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then `nawaban list`. The CLI picks the board from an explicit `--db`, then `NAWABAN_DB`, then `.nawaban/nawaban.db` in the repository's main checkout (so linked worktrees share it), then the nearest `.nawaban/` above the current directory. Several projects can share one board: pass the same absolute `--db` everywhere; a new task's project defaults to its parent's, then to the repository holding the board. `nawaban backup` copies the board into `backups/` beside it.

## Session identity

Commands that write as someone (`claim`, `close`, `event`) take the identity from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in every session, then from `NAWABAN_OWNER`. Codex sets no session variable, so set `NAWABAN_OWNER` to a stable name in the environment Codex runs commands in; without either variable those commands refuse and say so.

A leader reads `nawaban index` when it starts or after its context is compacted: what waits on you, what stopped, what moves, from the board or, in a repository whose `docs/agents/issue-tracker.md` names GitHub, from its issues. In such a repository, set `NAWABAN_OWNER_NAMES` (comma-separated) to the names the owner signs decisions with, so the index can tell the owner's decisions from the agents' in older comments; a decision written with `event '#N' --kind decision --by user` is counted by its marker.

## Herdr panel

The [Herdr](https://herdr.dev) app can show the board as a panel beside your terminals; it never writes the board, and on GitHub projects it hands your answers to a pending decision to the repository's orchestrator. It shows what waits on your decision in the focused space, the OKR reading, and the tasks on the board of the project that space is in, grouped by state; it runs `python3 ~/nawaban/nawaban/cli.py json ...` in the space's folder, or, for a project already moved to the Vercel Board (`cliFor` in the mod's `logic.js`: nawaban, bzkanbanv2, huafa), `node ~/nawaban/board/src/cli.ts json ...`, which needs Node 22.18 or later and `pnpm install` in `~/nawaban/board`. So it needs the checkout at `~/nawaban` (step 2 above) and `python3`.

1. Copy the mod into Herdr. Copy rather than symlink: Herdr does not reload a symlinked mod when it changes. Run the same command again after pulling to update it.

   ```sh
   cp -R ~/nawaban/herdr/mods/nawaban-board ~/.config/herdr-app/mods/
   herdr-app check ~/.config/herdr-app/mods/nawaban-board
   ```

   The mod has `"place": "none"`: it is not docked anywhere by itself. It opens in any layout as a window (`mod.open:nawaban-board`), which you can drag, that remembers where you dropped it and comes back on the next start until you close it with its ✕. Bind that in the `global` section of `~/.config/herdr-app/keys.json`:

   ```json
   "global": {
     "cmd-shift-j": "mod.open:nawaban-board"
   }
   ```

   To dock it in a layout instead, do steps 2 and 3; that layout's binding wins over the global one.

   The mod belongs on the computer that runs Herdr.app. When that app drives a space on another machine (Herdr.app on a MacBook Air showing a space that lives on a MacBook Pro), the panel runs `nawaban` on that machine through herdr-core: it reads `~/nawaban/nawaban/cli.py` under that machine's home, in the space's folder, so nawaban must be installed there too. Such a board is re-read every 5 seconds instead of being watched. A layout switch closes the window; open it again with the key.

2. Optional: dock the panel to a layout you own. Herdr's shipped layouts are read-only; clone one first if needed: `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`. In `~/.config/herdr-app/layouts/<layout>.json`, find the row that holds the terminals (in clones of `main` it is the row with id `work-body`) and add this block as its last child, so it sits on the right:

   ```json
   {
     "id": "nawaban",
     "type": "block",
     "hidden": true,
     "size": { "px": 420 },
     "min": 360,
     "max": 720,
     "background": "background",
     "radius": 8,
     "content": { "mod": "nawaban-board" }
   }
   ```

   It starts hidden, at 420 px; drag its edge to resize it between 360 and 720 px. Extra width goes to the titles. `background` and `radius` only paint the panel as a card; drop them if your layout has its own look.

3. Bind a key in `~/.config/herdr-app/keys.json`, in the section for that layout (create the section if it is missing):

   ```json
   "layout:<layout>": {
     "cmd-shift-j": "layout.toggle:nawaban"
   }
   ```

   Herdr does not use `cmd-shift-j` by default. On macOS a `ctrl-shift-j` binding did not toggle the panel while a terminal had focus (tested 2026-11-04 with Claude Code running in it); `cmd-shift-j` does. Avoid plain ctrl+letters such as `ctrl-k`: terminal programs need them. Without a key, `herdr-app do layout.toggle --id nawaban` opens and closes the panel.

Herdr applies both files within a second. A broken file is ignored, the last good version stays, and Herdr writes `~/.config/herdr-app/layout.error` or `keys.error`; `herdr-app status` lists the same problems under `errors`, which should be `[]`.

![The nawaban panel in Herdr (an older screenshot; the panel now follows the T3 Code sidebar look described below)](images/herdr-panel.png)

The panel shows one project, the one of the focused space, in the same three tabs whether its board is nawaban's or its GitHub issues: 待决 (what waits on your decision), OKR (the reading) and 任务 (the tasks). Only the picked tab is drawn. It follows the T3 Code sidebar: a black background, 8% white borders, 4% white on hover, 32 px single-line rows each led by a 6 px status dot, titles at 14 px, a 12 px number or duration on the right, and 11 px grey group headers with their count on the right. Dots: amber is waiting on you or stopped, sky blue is at work and slowly breathes, grey is not started or done. Top to bottom:

- **Header.** The project name; on the right, how many windows the space has and "其他项目 n 件等你", the items waiting on you in other projects.
- **Tabs.** Under the header, three text tabs; the picked one is brighter and underlined. Each label carries a count that says whether it needs you: 待决 the number waiting, in amber (none at 0); OKR the number of missed KRs in red, a green ✓ when every Objective is met, nothing otherwise or without an O; 任务 the open tasks, in grey. The panel opens on the tab you last picked for the project; the first time, on 待决 if anything waits, else on OKR. A click, ← →, or 1 2 3 switches.
- **待决 (Needs your decision).** One amber row per window waiting on you, titled with the task it is on, how long it has waited on the right, and a second grey line with its question. A window waits on you when it holds a task whose latest `triage:` note is `triage: needs-info — 等你：<question>`, or when Herdr reports it blocked (the question then reads 在等你确认). A waiting task of this project in no window of this space still gets a row. Below them, one row per pending decision. On a nawaban board its brief is the second line and it opens on GitHub. On a GitHub project the second line is "#n · KR · MM-DD" (the KR left out when the card's is empty or 无) and a chip on the right says what the card needs; a click opens it in place. A full card (【Decision】 【Objective / KR】 【Context】 two or more 【Options】 【Recommendation】, as `json board` parses it into `pending.card`) is 选一项: 背景, 最近进展 (two lines), one button per option, 建议, then 就这么定 / 不够，再说清楚 and a link to the full text on GitHub. A card with a later 进展 saying you already ruled (拍板, 回「行」, or a name in `NAWABAN_OWNER_NAMES`; `pending.ruled_after`) is 可能已定 in amber, with 对，已经定了 / 还没定. A card that sends you to a window (`pending.talk`: 去/到/在 <terminal> 窗口, or 窗口盘问) is 去窗口聊, with a button that goes to that terminal, or to the orchestrator once it is gone. Cards missing a field are one dim line, "卡片不全 N 张（#a #b），已退回编排者重写". Every answer is sent with `hc send` to the live terminal labelled `role=orchestrator` in this repository, as "[决策者经面板] #1280 选 A", "… 背景不够，请补写后重发待决", "… 已定，请核实后记已决"; the orchestrator records 已决, since the CLI refuses 已决 from a Herdr window. Incomplete cards go back on their own, "[决策者经面板] 卡片不全，请按决策卡格式重写：#a #b", once per card (a card rewritten later counts as new). With no live orchestrator the buttons are off and the card says so. With nothing waiting the tab says "没有等你决定的".
- **OKR.** The reading of `json okr`: a first line "3/5 达标 · 11-22 09:10 量", then the Objectives, those with a missed KR first, then those with a stale or untested one, all-met last. An Objective is a 15 px heading with met/total on the right, red when a KR missed. Under it the missed then stale KRs, each as its name over "<value> / 目标 ≥ 95% · 差 63.3 点 · 11-19": the gap counts toward the target (above it for ≥, below it for ≤, either side for =, "正好" at zero), percent and 百分点 in 点, red when missed, green when met, amber when stale; an untested KR reads "未测 · 目标 ≥ 10%". The untested KRs fold into "▸ N 条未测", the met ones into "▸ N 条已达标", and an all-met Objective is one grey line "<O> 全部达标 6/6"; each opens on a click or Enter and stay as you left them per project. A project without `docs/agents/okr.toml` shows "这个项目还没有 O" ("No Objective for this project yet") instead; while the reading is not in yet, or it failed for another reason, the tab stays empty.
- **Tasks.** Every root task of the board (a spec counts once, its ticket that needs you or is at work speaking for it), grouped by state: 停了 (stopped: held by a window that is idle or closed, or waiting on you somewhere this layer's first rows do not show), 在做 (at work; on GitHub also 在推, an issue with activity in the last 24 hours), 没动 (not started), 完成 (done). Each group header folds its rows; all start open, and the panel remembers each choice per project and group across restarts. 完成 shows its newest 5, then "再显示 N 条" to show the rest and "收起" to fold them back, also remembered. On the right a row says for how long (在做, 停了) or when it was done (a time today, else 昨天 or the date). Only 停了 rows take a second grey line: "窗口已关，任务还拿着没交还" when the window is gone, then the latest progress note.
- **GitHub projects.** In a repository whose `docs/agents/issue-tracker.md` names GitHub, the tasks are its issues. An issue's window is the terminal its `认领：` comment names (`hc t5n`), else one named `gh-<n>…` (`hc run --name gh-275`) that no other issue claims. Open and unclaimed is 没动; 在干 while its window works or 在推 within 24 hours of its last activity is 在做; quiet longer, or `needs-info`, is 停了; closed is 完成.

Details stay out of the rows. Resting the pointer on a row opens a hover card (a Herdr `HoverCard`) with its ID, latest progress or question, window and how long; on a KR, its value, target, date, source, trend, rounds missed and what it waits on you to do. While a row is hovered or selected, "去窗口" (or "去 GitHub") with an arrow takes the place of the time on the right; clicking the row goes there (`agent.focus`). The group chevrons show only on hover or selection.

The panel takes the keyboard when you click it or reach it with `pane.go`. Then ← → (or 1 2 3) switch tabs, and ↑ and ↓ walk the picked tab: the rows of 待决 (Enter opens a card); the KRs and the 未测 and 已达标 folds; or each group header and the rows of the open groups, including the 完成 "再显示" row; Enter folds or opens a selected group header, shows more or fewer done tasks, or goes to the selected row's window; Esc clears the selection; `pane.go` (or a click elsewhere) hands the keyboard back. Herdr's hover card opens for the pointer only, so with the keyboard the selected row's details open in the panel, right below it. Each of these is also a command, `nawaban-board.down`, `.up`, `.open`, `.back` and `.focus` (takes the keyboard), for a `keys.json` binding or `herdr-app do nawaban-board.open`; Herdr delivers them only while the panel is shown. The ⋯ menu switches the labels between Chinese and English.

The panel rereads the board when the board file changes, and when a window of the space comes, goes or changes state, not on a clock; it also rereads once a minute in case a change was missed. A GitHub project's board is read from GitHub at most once a minute; a reread sooner reuses the last one.
