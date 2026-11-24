# CLI 简化：一屏 help，一件事一种写法

NAWABAN-CLI-SIMPLE。只出设计和拆票，不写代码。仓库 `9445c6f`，插件 0.3.0，`@vercel/board` 0.53.0。

## Problem

决策者 11-25 的要求是 CLI 像 pstack 的 skill 一样短：一屏 help，一件事一个词，输出形状固定。现状有四处不符，都是实测。

- **help 里没有日常动词。** `nawaban --help` 打印 119 行，全部是上游 `@vercel/board` 的动词（grants、channels、schemas、read、post、tasks …）。agent 每天敲的 `show claim event close create dispatch merge okr index` 一个都不在里面。
- **动词自己的 help 不存在。** `nawaban show --help`、`event --help`、`dispatch --help`、`okr --help` 都报 `Unknown option '--help'`。7 天里 agent 试了 100 次 `--help`，其中 50 次是 `event`。
- **一件事有多种写法。** 调用名有三种：`python3 …/nawaban/cli.py`（3383 次）、`node …/board/src/cli.ts`（1171 次）、PATH 上的 `nawaban`（65 次）。看一张票的 JSON 有 `json task`（116 次）和 `show --json`（13 次）。读票的事件有 `show` 和上游 `read`（34 次）。
- **同词异义。** `block <票> <挡它的票>` 加依赖边，上游 `tasks block <id> <原因>` 是挂起。`claim` 和 `tasks claim`、`renew` 和 `tasks renew` 各有两个入口。nawaban 的 `inbox` 遮住了上游的 `inbox <key>`。

任务系统评审（`~/.nawaban/reviews/task.md` C4）已经指出两套实现、多份事实。本文只设计板 CLI（`board/src`）的命令面。旧 CLI（`nawaban/cli.py`）不重新设计，理由见「迁移」。

## 1. 盘点

### 量法

盘点脚本读 `~/.claude/projects` 和 `~/.codex/sessions` 里近 7 天的会话记录（1973 个文件），只解析工具调用里的命令串，只输出动词和 flag 的计数。它按 tool_use id 去重，去掉 heredoc 和带空格的引号内容，只数命令位置上的调用。窗口是 2026-11-17 17:15Z 到 11-24 17:15Z。283 个会话至少调过一次，其中 10 个跑过 `dispatch`，按编排者算。脚本和原始输出贴在本规格的 PR 评论里。

三条局限：

- Code Mode 会话把路径放在变量里，脚本数不到，所以板 CLI 的次数偏低。
- 钩子和面板的调用不进会话记录，下表单列。
- 板上原生票从 11-20 14:24Z 才有，看板事件一栏只覆盖 4 天，而且含导入的历史票（推断，没逐条核）。

### 会话里实际敲的命令（7 天，共 4619 次）

「板」是 `cli.ts`，「旧」是 `cli.py`，「短名」是 PATH 上的 `nawaban`。会话数是三种写法相加，同一会话用两种写法会算两次。少于 3 次的行在 PR 评论的原始输出里。

| 命令 | 板 | 旧 | 短名 | 会话 | 其中 `--help` |
| --- | --- | --- | --- | --- | --- |
| `event --kind note` | 202 | 860 | 2 | 231 |  |
| `event --kind decision` | 81 | 609 | 2 | 132 |  |
| `claim` | 73 | 336 | 6 | 220 | 6 |
| `event --kind link` | 65 | 232 | 0 | 204 | 1 |
| `close` | 59 | 221 | 0 | 58 | 5 |
| `show` | 195 | 77 | 2 | 82 | 3 |
| `dispatch` | 40 | 173 | 5 | 13 | 16 |
| `create` | 100 | 105 | 0 | 20 | 6 |
| `okr` | 8 | 136 | 23 | 61 | 5 |
| `event --kind ask` | 18 | 145 | 1 | 22 |  |
| `event --kind impact` | 0 | 155 | 5 | 72 |  |
| `event --kind resolve` | 0 | 138 | 0 | 2 |  |
| `json task` | 106 | 10 | 0 | 10 |  |
| `event` | 13 | 39 | 6 | 36 | 50 |
| `list` | 33 | 23 | 0 | 19 | 1 |
| `json board` | 14 | 21 | 0 | 11 |  |
| `read` | 34 | 0 | 0 | 15 | 1 |
| `json okr` | 7 | 26 | 0 | 16 |  |
| `brief` | 0 | 31 | 0 | 8 |  |
| `serve` | 22 | 0 | 2 | 9 |  |
| `tasks unblock` | 18 | 0 | 0 | 2 |  |
| `index` | 6 | 10 | 0 | 9 |  |
| `json` | 0 | 13 | 0 | 6 |  |
| `label` | 10 | 0 | 0 | 1 |  |
| `page` | 9 | 0 | 0 | 4 |  |
| `json projects` | 3 | 5 | 1 | 6 |  |
| `tasks claim` | 7 | 0 | 0 | 4 |  |
| `inbox` | 7 | 0 | 0 | 5 |  |
| `backup` | 0 | 6 | 0 | 2 |  |
| `renew` | 5 | 0 | 0 | 2 |  |
| `（不存在）help` | 5 | 0 | 0 | 5 |  |
| `merge` | 4 | 0 | 1 | 3 |  |
| `init` | 0 | 4 | 0 | 4 |  |
| `guard` | 4 | 0 | 0 | 3 |  |
| `tasks complete` | 3 | 0 | 1 | 3 |  |
| `web` | 3 | 0 | 0 | 1 |  |
| `channels create` | 3 | 0 | 0 | 1 |  |
| `tasks` | 2 | 0 | 1 | 3 | 2 |

读法：

- `event` 合计 2576 次，占 56%。它是这个 CLI 的主路径。
- 决策者手敲（`!` 前缀）的 nawaban 命令没测到。检测靠会话记录里的 `<bash-input>`，这个格式对着别的仓库里一条已知的 `!` 命令核过。
- Codex 会话 12 次，全是 `show` 和 `json task`。
- agent 猜过 13 种不存在的动词，共 19 次（不算本次盘点自己试的 1 次）：`help` 5，`note` 2，`board` 2，`decision link resolve unblock release open ls log` 等各 1。`note`、`decision`、`link`、`resolve` 说明 agent 想把事件的类当动词敲。
- skill 写了但板 CLI 没实现的 flag：`--take` 在板上试了 3 次，`--reopen` 试了 1 次。`show` 上猜过 `--all`、`--full`、`--events` 各 1 次。

### 不经会话的调用方（读代码）

| 调用方 | 调什么 | 位置 |
| --- | --- | --- |
| SessionStart 钩子 | 板 `index --project`，旧 `index` | `hooks/leader-index.sh:14,16` |
| UserPromptSubmit 钩子 | `renew --session`、`page --project --session` | `hooks/renew.sh:12`、`hooks/page-writes.sh:11` |
| PostToolUse 钩子 | `renew --session`、`progress` | `hooks/renew.sh:12`、`hooks/progress.sh:13` |
| PreToolUse 钩子 | `guard`；另有两个钩子把 `cli.py` 当模块 import | `hooks/board-impact-guard.sh:19`、`hooks/impact-guard.sh:21`、`hooks/retire-guard.sh:11` |
| Stop 钩子 | `inbox --project`；两个钩子都 import `cli.py` | `hooks/inbox.sh:12,20`、`hooks/ask-guard.sh:13` |
| Herdr 面板 | `json projects`、`json db`、`json board`、`json okr`。面板对两套 CLI 发同一组参数，另一台机器固定走旧 CLI | `herdr/mods/nawaban-board/main.js:83-99,266,284,292,372` |
| 网页 | 浏览器不调 CLI，走 `/api/nawaban/*`。服务端给 GitHub 记账的仓库记已决时调 `cli.py event … --kind resolve --by user` | `web/src/main.tsx:62`、`board/src/server.ts:341`、`board/src/github.ts:9` |
| 板 CLI 自己 | 进程内直接调上游的 `reply`、`tasks block`、`tasks claim`、`tasks release`、`tasks complete`、`tasks renew`，不经顶层分发，改名不影响它们。只有派单替 worker 认领时起子进程跑顶层的 `tasks claim --as` | `board/src/events.ts:92,93`、`board/src/tasks.ts:16,185-289`、`board/src/dispatch.ts:269` |
| 旧 CLI 调板 CLI | retire-guard 跑 `cli.ts list --json`，不带 `--project`，要全部项目 | `nawaban/cli.py:1492` |
| 打印给 agent 照着敲的提示 | 网页已答、收件箱、影响声明的提示里写着 `event … --kind`、`create … --body`、`label`、`page` | `board/src/page.ts:108,114`、`board/src/orchestrator.ts:190`、`board/src/impact.ts:94` |
| 派单 brief | `show`、`claim`、`event`、`close`、`merge` 的全路径写法 | `board/src/dispatch.ts:210,221` |
| 安装 | PATH 上的 `nawaban` 包装脚本，launchd 的 `serve` | `install.sh:46,75` |
| 文档 | roubao 的 `docs/agents/issue-tracker.md` 写了 `cli.py claim`、`event`、`close`、`brief`；`~/.claude/AGENTS.md` 写了 `nawaban event`、`okr`、`dispatch` | 各仓库 |
| 按命令文本匹配的守卫 | `closeGate` 的正则认 `tasks complete`、`fail`、`cancel`。ask-guard 的正则只认 `--kind ask` 和 `triage: needs-info` | `board/src/impact.ts:24`、`nawaban/cli.py:1904` |

### 看板事件（11-20 起，本机板）

任务事件：建 128，认领 75，完成 49，作废 53，挂起 30，解除 24，续租 32，过期 9，交还 8，改依赖 4。回复 486 条：纯文本备注 174，决策记录 108，链接 67，`triage:` 备注 44，派单记录 40，`lane:` 备注 25，KR 读数 20，其余 8。634 条消息里 589 条没带会话身份。

### 没人用的

- **上游动词，7 天 0 次，也没有静态调用方：** `grants` 全部、`schemas` 全部、`actors`、`post`、`schedule`、`schedules`、`edit`、`delete`、`react`、`typing`、`sync`、`sources`、`download`、`conformance`、`tail`、`wait`、`tasks run`、`tasks fail`、`tasks reopen`、`tasks assign`、`tasks needs`、`hooks uninstall`。
- **nawaban 动词，近乎 0：** `block` 1 次，`import` 1 次，`whoami` 1 次。
- **flag：** `event` 的 `--question`、`--verdict`、`--rejected` 各 1 次。

## 2. 目标命令面

### 从零推出来的形状

票的一生只有四步：建、认领、记事件、关。读只有三个问题：现在要管什么，这张票怎样，有哪些票。再加上派活、合并、读数，一共十件事，一件事一个动词。

名词一个概念一个词：

| 词 | 含义 | 今天还叫 |
| --- | --- | --- |
| 票 | 一件要做的事，`<票>` 是它的 KEY 或板上编号（纯数字，不带 `#`）。`'#N'` 只指 GitHub issue，由 MIGRATE-10 的编号映射实现 | task、任务、卡、`<key>`、`<id>`、`<key\|id>`、`<ID>` |
| 事件 | 票上只追加的一条记录，有六类 | event、回复、评论 |
| 待决 | 等决策者拍板的一件事，`ask` 提出，`resolve` 结束 | 待决策项、决策卡、DR、等你 |
| 读数 | 一条 KR 在某一天量到的值 | reading、现值、实际 |
| 泳道 | 开工前要读同一批东西的一组票 | lane |

这张表和 GLOSSARY 有一处冲突。GLOSSARY 的词条是「任务」，票正文和决策者的追加要求用「票」。本文照决策者的用词，GLOSSARY 的词条由 -07 改。NAWABAN-VOCAB 如果裁定英文术语，只改 help 的字符串，不改动词。

事件的六类是一个带标签的联合，每类有自己的字段。所以类是位置参数，每类只收自己的 flag，`event --help` 一类一行。今天六类的 flag 混在一个解析器里，`--kr` 在 `decision`、`ask`、`impact` 上各有一种格式。

### 新 `nawaban --help`（草稿，21 行）

```
nawaban：记票、事件、待决和读数的看板

用法：nawaban <动词> [参数]

看
  status              现在要管的：待决、停滞、进行中、可开工
  show <票>           一张票：正文、负责人、被挡、最近事件
  list                票，一行一张
  okr                 各 O 的 KR 读数对目标
写
  create <票>         建票
  claim <票>          认领；--release 交还
  event <票> <类>     记事件：note decision link impact ask resolve
  close <票>          关票：--done 或 --cancelled
派
  dispatch <票>       把票派给 worker
  merge <PR>          合并 PR，关票，领下一张或收掉 worker

<票> 是 KEY 或板上的编号；同步仓库里是 GitHub 的 '#N'。
每个动词加 --help 看参数，加 --json 给机器读。
少用的和本机服务：nawaban help more
```

这十个动词覆盖 7 天里 4619 次调用的 96.3%（4450 次，按「旧到新对照」折算）。草稿是 -02 合并之后的样子。脚注里的 `--json` 到 -04 才每个动词都有，`'#N'` 要等 MIGRATE-10，-02 的 help 先不写这两句。

### `nawaban help more`（草稿）

```
少用
  block <票> <挡它的票>   建票之后补一条被挡
  web                     在浏览器打开网页版；--tailnet 打印外网地址
本机服务
  serve                   起看板服务，launchd 调
  import                  从旧 nawaban.db 导入
  hook <名>               钩子入口 renew、progress、guard，不手敲
  json <什么>             面板读的 JSON，不手敲
上游
  board <动词…>           @vercel/board 的原生动词：nawaban board --help
```

### 每个动词的参数

| 动词 | 用法 | 说明 |
| --- | --- | --- |
| `status` | `status [--project <项目>] [--line] [--unseen <会话>]` | 默认打印整份索引。`--line` 只打印待决提示行，Stop 钩子用。`--unseen` 只打印这个会话没见过的网页答复和收件箱条目，UserPromptSubmit 钩子用。 |
| `show` | `show <票> [--all]` | 默认最近 20 条事件，`--all` 全部。 |
| `list` | `list [--project <项目>] [--parent <票>] [--ready]` | 不带 `--project` 列全部项目，和今天一样。`--ready` 只列可开工的。 |
| `okr` | `okr [--accept <O>]` | 不变。OKR v2 的 `--resume` 加在这里。 |
| `create` | `create <票> --title <标题> [正文] [--parent <票>] [--blocked-by <票>]… [--lane <泳道>] [--inbox <条目>]` | `--inbox` 把收件箱条目转成这张票，并标成已处理。 |
| `claim` | `claim <票> [--release]` | OKR v2 的 V2-03 在这里加 `--o`、`--kr`。 |
| `event` | `event <票> <类> [正文] [该类的参数]` | 见下。 |
| `close` | `close <票> (--done \| --cancelled)` | |
| `dispatch` | `dispatch [<票>] --brief <文本> --accept <文本> [--agent <a>] [--model <m>] [--to <终端> \| --new] [--name <名>]` | 不变。不带票时要 `--name`，什么都不记。 |
| `merge` | `merge <PR>` | 不变。 |

所有动词共用的规则：

- **项目。** `create` 和 `status` 要有项目才能跑，`--project` 缺省取当前目录所在仓库的项目。今天 `create` 的 100 次里 76 次手写了 `--project`。`list` 的 `--project` 是过滤，不填就是全部。
- **正文。** 位置参数，写 `-` 从标准输入读，和 Board 原生的 `reply <id> [text]` 一个约定。`event` 不加 `--body-file`（决策者 11-25：不造轮子，Board 有的约定直接用）；`create` 上原有的 `--body-file` 保留。今天 `event` 只认 `--body`，`create` 认 `--body` 和 `--body-file`，把位置参数静默丢掉（实测）。以 `-` 开头的正文今天写不进去（`--body "- 已完成"` 报 `argument is ambiguous`），新写法下走标准输入或 `--body-file`。
- **`--json`。** 每个动词都有，输出一个对象。面板读的 `json …` 不动，见「去掉的东西」第 4 条。
- **`--help`。** 每个动词都有，打印用法一行加每个参数一行。
- **谁定的。** `--by user` 只在 `decision` 上，和今天一样。

### `nawaban event --help`（草稿）

```
用法：nawaban event <票> <类> [正文] [参数]

  note <正文>        进展同步：已完成：… / 下一步：… / 卡点：…
  decision <正文>    决策记录：决定：… 背景：… 否决方案：…
                     --by user 是决策者定的；--kr <O / KR> 是代定且挂 KR
  link <前缀:地址>   前缀是 pr、commit、artifact、adr
  impact             KR 影响声明：--o <O> --kr "<KR>=↑ 90→95 预计"…
                     纯基础设施写 --o 无
  ask <决策事项>     上升一件待决：--kr、--context、--option（至少两次）、--rec
  resolve <正文>     已决，解除 ask 留下的挂起

正文写 - 从标准输入读。
```

### 输出

默认一两行中文。第一行是结果，第二行只在有下一步时出现。

```
✓ 认领 NAWABAN-CLI-SIMPLE，租约到 18:10
✗ NAWABAN-CLI-SIMPLE 在 cc-0a81b66e 手里，租约到 18:10
  等它交还，或让编排者改派
```

今天板 CLI 的写动词打印英文（`#1251  yours for 1h`、`error: no task X`），旧 CLI 打印中文的 ✓ 和 ✗。退出码只有四个：0 成功，1 被拒，2 用法错，3 还在等（`merge` 等 CI）。`hook guard` 例外：它照钩子协议走，拦下工具调用时退出 2。

一行一张票的输出以 KEY 开头，板上编号不带 `#`。今天每行以 `#<板上编号>` 开头，而 `show '#4'` 报 `no task #4`（实测），和 GitHub 的 `'#N'` 撞。

未知动词不再落到上游。它打印 `✗ 没有动词 <词>`，然后列出十个动词，退出码 2。

### 旧到新对照

| 旧写法 | 新写法 |
| --- | --- |
| `node …/cli.ts <动词>` | `nawaban <动词>` |
| `python3 …/cli.py … <动词>` | 不变，见「迁移」 |
| `index [--project]` | `status` |
| `inbox --project` | `status --line` |
| `page --project [--session]` | `status --unseen <会话>`，不带会话时并进 `status` |
| `brief`（只在旧 CLI） | 不变。MIGRATE-10-02 把读切到本地板时，待决的原文和近期进展并进 `status` 的待决一节 |
| agent 手敲的 `json task <票>` | `show <票> --json` |
| agent 手敲的 `json board`、`json okr` | `status --json`、`okr --json` |
| 面板调的 `json projects`、`json db`、`json board`、`json task`、`json okr [--repo]` | 不变，移到 `help more` |
| `show <票>` | 不变，加 `--all` |
| `read <id>` | `show <票> --all` |
| `list --frontier` | `list --ready` |
| `create … --body <文本>` | `create … <文本>` |
| `claim`、`claim --release` | 不变 |
| `tasks claim --as <别的会话>`（派单替 worker 认领） | `board tasks claim --as …`，只有 `dispatch.ts:269` 调 |
| `tasks renew`、`tasks release` | `hook renew`、`claim --release` |
| `event <票> --kind <类> --body <文本>` | `event <票> <类> <文本>` |
| `event … --kind decision --question --verdict --rejected` | 删这三个 flag，正文照决策记录的格式写 |
| `tasks unblock <id>` | `board tasks unblock <id>`。`resolve` 只解 `ask` 留下的挂起，「等你」和手动挂起它解不开（实测） |
| `close --done`、`close --cancelled` | 不变 |
| `tasks complete`、`tasks fail`、`tasks cancel` | `close`；守卫照旧拦直调 |
| `block <票> <挡它的票>` | 不变，移到 `help more` |
| `dispatch`、`merge`、`okr`、`okr --accept` | 不变 |
| `renew --session`、`progress`、`guard` | `hook renew`、`hook progress`、`hook guard` |
| `label <id> inbox=done task=<KEY> --if inbox=open` | `create <票> --inbox <条目>`；只标已处理仍用 `board label` |
| `grants`、`channels`、`schemas`、`read`、`post`、`reply`、`tasks …` 等上游动词 | `board <动词…>` |
| `web`、`serve`、`import` | 不变，移到 `help more` |
| `init`、`backup`（只在旧 CLI） | 不进新命令面，随旧 CLI 走 |

## 3. 去掉的东西和理由

1. **上游 119 行 help。** 上游动词 7 天里只有 `read`、`label`、`reply`、`whoami`、`channels create` 和五个 `tasks` 子命令被调过，其余 0 次。它们留在 `nawaban board` 后面，nawaban 自己的 help 不再列。
2. **未知动词落到上游。** 它造成四组同词异义，也让猜错的动词报出上游的英文错误。
3. **`index`、`inbox`、`page` 三个动词。** 它们打印的是同一份「现在要管什么」的不同切面，`index` 的结尾本来就接着 `page`。合成 `status` 加两个 flag。旧 CLI 的 `brief` 是第四个切面，等 MIGRATE-10-02 把读切到本地板时并进来。
4. **agent 手敲的 `json`。** agent 7 天里敲了 206 次 `json …`，它和 `--json` 是同一件事的两种写法。skill 不再教 `json`，agent 用 `--json`。`json` 动词本身留着，移到 `help more`：面板对两套 CLI 发同一组参数（`main.js:83-99`），靠 `json projects` 认当前项目，靠 `json db` 拿板文件路径来监听变化。旧 CLI 还在，这组参数就不能改。
5. **`--kind` 和 `--body`。** 类和正文是 `event` 的必填项，必填项用位置参数。agent 已经在把类当动词猜。
6. **`--question`、`--verdict`、`--rejected`。** 各 1 次。GLOSSARY 已经把这组旧格式标成「照样读」，写的一侧不需要。
7. **skill 里的 `claim --take` 和 `close --reopen`。** 板 CLI 没实现，试的 4 次全部报错。租约过期后票自己回到可开工，不需要接手。误关的票在板上重开不了：上游的 `tasks reopen` 只重开失败的票，对已完成和已作废的报 `Can't reopen task. It's finished.`（实测）。skill 改成照实写：误关了就建一张新票，在旧票上记一条链接。要不要给板加重开，本文不设计。
8. **三种调用名。** 板记账的仓库只写 `nawaban`。包装脚本 `install.sh` 已经装了，只是 skill 让 agent 把全路径写出来。
9. **顶层的 `renew`、`progress`、`guard`。** 只有钩子调，收进 `hook`。
10. **`whoami`、`conformance` 等没人用的上游动词。** 不单独处理，跟着第 1 条进 `board`。

有两样没去掉。`block` 7 天只有 1 次，但建票之后补依赖没有别的写法，留在 `help more`。`dispatch --name` 用了 12 次，留着。

## 4. 迁移

### 旧 CLI 的动词不动

`nawaban/cli.py` 不改动词，也不加新写法。三条理由：

- MIGRATE-10 第 7 节承诺 roubao 的 `issue-tracker.md` 一个字不改，岳不同的机器继续直接用旧 CLI 写 GitHub。`cli.py claim`、`event`、`close` 加 `'#N'` 是冻结的写法。新写法喂给旧 CLI 是用法错（`cli.py event X note 正文` 报 `the following arguments are required: --kind`，实测）。
- OKR v2 只做在板 CLI 上，理由相同。
- 7 天里旧 CLI 仍占 4619 次里的 3383 次。

所以两套文法各写在各的地方：

- `skills/nawaban/SKILL.md` 是两套 CLI 共用的。改写后它分两节，板记账的仓库一节用新写法，GitHub 记账的仓库一节保留 `--kind`、`--body`。
- `~/.claude/AGENTS.md` 对所有仓库生效，里面的 `nawaban event … --kind` 不改，等 roubao 不再用旧 CLI 再说。
- 网页服务端调 `cli.py event … --kind resolve --by user`（`server.ts:341`），不改。

例外有两处，它们住在 `cli.py` 里，但认的是板 CLI 的命令文本，要跟着新写法改：

- `cli.py:1904` 的 `_RECORDED`。它只认 `--kind ask` 和 `triage: needs-info`。喂新写法的 `event X ask …`，ask-guard 把已经记过的待决判成没记，拦住 Stop（实测）。-02 把它改成两种写法都认，并改掉它打印的补救命令。
- `cli.py` 对已迁项目打印的「已迁到 Board」提示，里面是板 CLI 的旧写法。-02 一起改。

MIGRATE-10-03 之后，同步仓库的写动词由旧 CLI 转给板 CLI，转过来的是 `--kind`、`--body`。转发处把它换成新写法。-02 先合并的话，这段归 MIGRATE-10-03，-02 在那张票上留备注。

### 板 CLI 的旧写法当别名，三个条件都满足才删

板 CLI 的每个旧写法在改名的同一个 PR 里变成别名。别名照常执行，并在 stderr 打一行 `改用：nawaban <新写法>`。提示里的新写法必须是一条能跑通的命令。

-07 删别名，要同时满足：

1. 盘点脚本连续 7 天数到 0 次旧写法。在途 worker 的 brief 里有旧写法，所以不设固定日期。
2. 仓库里 grep 不到旧写法的静态调用点和子进程调用点。会话记录看不到这两种调用，它们是 `dispatch.ts:269`、`cli.py:1492`、六个钩子脚本、`page.ts:108,114`、`orchestrator.ts:190`、`impact.ts:94`。
3. MIGRATE-10-03 已合并，旧 CLI 的转发处已经换成新写法。否则 roubao 冻结的写法转过来会被拒，而计数看不出来。

### 一起改的调用方

每张子票在同一个 PR 里改掉它动到的调用方，不留只改了一半的状态。上面「不经会话的调用方」表里的每一行都归到一张子票，见「拆票」。

守卫按命令文本匹配，动词改名后可能不再命中而不报错。新写法的命令串喂给这些守卫的结果：

- `closeGate`（`impact.ts:24`）照样拦 `nawaban board tasks complete`、`fail`、`cancel`，放行 `nawaban close`（实测）。
- `hooks/repo_write.py`、`hooks/comment-guard.sh`、retire-guard 用的 `cli.retiring_terminals` 行为不变（评审员实测，我没复跑）。
- ask-guard 出错，见上。

动到命令文本的子票各补一条用新写法的守卫用例。

### 和其他规格的先后

| 规格 | 关系 | 先后 |
| --- | --- | --- |
| NAWABAN-OKR-V2 | V2-01 到 V2-05 都改 `board/src/okr.ts`。V2-03 给 `claim` 加 `--o`、`--kr`，改 `impact` 的字段，让 `close --done` 补结果。V2-04 加 `okr --resume`。okr.toml 草案里有 `okr-stat verdicts`。 | -02 只动 `event` 的类和正文怎么传，不动各类自己的 flag，所以不等 V2-03。V2-03 的新 flag 直接按新文法加。-04 给 `okr` 加 `--json` 要改 `okr.ts:429` 一带，派之前等 okr 泳道在跑的那张合并。`okr-stat` 是量法调的，不是人敲的，建议叫 `hook okr-stat`，归 V2 的票定。 |
| NAWABAN-MIGRATE-10 | -02 把 index、待决提示行、brief、面板的读切到本地板，并删 GitHub 读路径。-03 让旧 CLI 转发写动词。-04 加 `share <票>` 或 `create --share`。第 6 节提到 `nawaban sync status`。 | -05 排在 MIGRATE-10-02 之后，`status` 只合并一次。-07 排在 MIGRATE-10-03 之后。`sync` 是上游动词，按本文会收进 `board`，所以建议推送失败并进 `status`，分享只做 `create --share` 和 `help more` 里的 `share <票>`，归 MIGRATE-10 的票定。 |
| NAWABAN-VOCAB | 名词用中文还是英文术语，未裁定。 | 不挡。help 的字符串集中在一处，VOCAB 裁定后改字符串。 |

### 待决策者确认

1. **「等你」并进待决。** 今天「等你」是一条备注，正文以 `triage: needs-info — 等你：` 开头，读的一侧靠这个前缀把票挂起。答复之后还要再写两条：一条 `decision --by user`，一条 `triage: ready-for-agent`。`resolve` 解不开它。建议加第七类 `event <票> wait <一行问题>`，并让 `resolve` 也解这种挂起，三条命令变两条，前缀不再有副作用。旧前缀照样读。代价有三条：待决提示行里「等你」和待决策项用同一个词；就绪标准只管 `ask`，不管 `wait`；ask-guard 的正则要认 `wait`。不做的话 `triage:` 前缀照旧，-06 只做 `--lane`。
2. **拆法。** 见下。

## 拆票

竖切，每张都能单独演示。key 是 NAWABAN-CLI-SIMPLE-01 到 -07，parent 是 NAWABAN-CLI-SIMPLE，同一条泳道 `cli`，依次做。help 只列当时已经能跑的写法。每张票加一条检查，把 help 里每一行的写法跑一遍。子票等决策者看过拆法再建。

| 子票 | 做什么 | 演示 | 被挡 |
| --- | --- | --- | --- |
| -01 一屏 help | 新 `nawaban --help` 和 `help more`；每个动词的 `--help`；上游动词收进 `board`，钩子入口收进 `hook`，六个钩子脚本和 `dispatch.ts:269` 的子进程调用同一个 PR 改；`index` 改名 `status`；未知动词报错并列出十个动词；旧的顶层写法变别名。`event` 那一行先写今天的 `--kind` 文法 | `nawaban --help` 不超过 24 行 80 列；help 里每一行的写法都跑通；`nawaban event --help` 退出 0；`nawaban bogus` 退出 2；`hook guard` 拦 `nawaban board tasks complete` 时退出 2 | 无 |
| -02 事件的类 | `event <票> <类> [正文]`；正文位置参数、`-`，`create` 同样并保留它原有的 `--body-file`；删 `--question`、`--verdict`、`--rejected`；ask-guard 的 `_RECORDED` 和它的补救提示、`page.ts`、`impact.ts`、`cli.py` 的「已迁到 Board」提示、派单 brief 一起改 | `nawaban event X note "…"` 写成；以 `-` 开头的正文从标准输入写成；旧写法照常执行并打出改用提示；喂新写法的 `event X ask …`，ask-guard 放行 | -01 |
| -03 一个调用名 | 板记账仓库的 skill 一节、派单 brief、钩子提示、`docs/agents` 全部写 `nawaban <动词>`；`create` 和 `status` 的 `--project` 缺省取当前仓库 | 新派的 worker 的 brief 里没有 `cli.ts` 路径；在仓库里 `nawaban create X --title t` 不带 `--project` 能建票；Codex 沙箱里 `nawaban show X` 能跑 | -01 |
| -04 输出 | 写动词默认一两行中文的 ✓ 和 ✗，被拒时第二行给下一步；每个动词有 `--json`；退出码四个，`hook guard` 例外；行输出以 KEY 开头，板上编号不带 `#` | 十个动词各一条成功、一条被拒的输出快照 | -02 |
| -05 status | `inbox`、`page` 合进 `status` 的 `--line`、`--unseen`，三个钩子同一个 PR 改；`show --all`；`create --inbox`；skill 不再教 `json`，`orchestrator.ts:190` 的提示一起改 | 待决提示行、网页答复提示、收件箱提示在新写法下照常出现；面板不改，`herdr-app check` 过 | -04、NAWABAN-MIGRATE-10-02 |
| -06 泳道和等你 | `create --lane`，读的一侧照样读旧的 `lane:` 备注；决策者同意第 1 问后加 `wait`，`resolve` 也解它，ask-guard 认它 | `nawaban create X --title t --lane cli` 之后 `dispatch X` 交给 `cli` 泳道的 worker；`wait` 之后 `resolve` 解除挂起 | -02；`wait` 部分等第 1 问 |
| -07 收尾 | 盘点脚本和静态调用点的 grep 检查进仓库；三个条件满足后删全部别名；GLOSSARY 的「任务」改「票」；skill 删掉 `--take`、`--reopen`，写明误关的票重开不了，分板和 GitHub 两节重写，目标是 `skills/nawaban/SKILL.md` 从 186 行减到 100 行以内 | 盘点脚本输出里旧写法为 0；`nawaban index` 退出 2 | -03、-05、-06、NAWABAN-MIGRATE-10-03 |

## 还没实跑的

| 机制 | 风险 | 子票 |
| --- | --- | --- |
| 在 `runCommand` 里先拦 `--help` 和未知动词，再决定要不要调 `app.run` | 读代码看是可行的（`board/src/cli.ts:35-49`，分发在我们自己的函数里）。上游 `createApp` 自己的 `--help` 和报错会打印 `nawaban <command>`，在 `board` 后面少一个词 | -01 |
| 包装脚本 `nawaban` 在 Codex 沙箱和 subagent 的 Bash 里能直接跑 | skill 今天要求写全路径，理由是 subagent 的 Bash 拒绝运行时拼出来的命令名。字面量 `nawaban` 不在这个限制里，但没在 Codex 上实跑 | -03 |
| 会话环境里预置了 `BOARD_URL=http://127.0.0.1:4100/api/board` | 只设 `NAWABAN_BOARD_DIR` 和 `NAWABAN_BOARD_PORT` 的临时板，CLI 仍连 4100（评审时实测，被 token 拒了，没写进去）。测试用的临时板要显式改 `BOARD_URL` | -01 |
| `resolve` 解「等你」的挂起 | 今天 `resolve` 对 `needs_input` 报 `has no decision waiting`。让它也解，要看上游的 `tasks unblock` 对持票人和 owner 的限制 | -06 |
| 盘点脚本的次数 | Code Mode 会话数不到；引号里带空格的路径数不到；子进程和钩子调用不进会话记录 | -07 |
