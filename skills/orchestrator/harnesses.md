# 没有 Claude Code 钩子时

- **钩子不跑的任何会话** → 照样把改文件交给 worker 或 subagent。
- **Herdr 之外的 Claude Code** → 声明按会话 id 保存。`/clear` 或换了会话 id，重新敲 `/nawaban:orchestrator`。
- **Codex** → 用 `$orchestrator` 声明。钩子要在 `/hooks` 里信任后才跑；`codex plugin add` 改了插件后要重新信任并重启。用 `codex --no-daemon` 启动，Herdr 才给终端贴标签。
- **Antigravity** → 用 `/nawaban:orchestrator` 声明。待决行在每轮开头以系统消息到达，回复照字开头写那行 `待决 …`。ask guard 退回的回复以 `Stop hook blocked termination:` 到达，改掉它点名的问题再回。`agy -c` 之后跑一次 `nawaban status --project <p>`。
- **钩子没被信任的 Codex，或没有钩子的 agent** → 每轮开头跑 `nawaban status --project <p>`，处理其中的等你、网页已答和收件箱。问之前先 `nawaban event <ID> ask` 记下。Codex 上别跑 `status --line`，沙箱会拒。
