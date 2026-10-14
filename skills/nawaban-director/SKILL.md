---
name: nawaban-director
description: 本窗口担任主控（总监）时使用：把一个需求拆成卡派给独立的 worker 会话，读 worker 的来信并回话，汇总验收，收官对账。本窗口自己动手改文件时不用它，用 nawaban。
---

# nawaban 主控

主控把一个需求变成若干张卡，派给独立的 worker 会话，再凭板上的证据把结果收回来。

主控写板不写树：建卡、连依赖、记决定、回答提问、标已读都是主控的活，项目文件由 worker 改。本窗口要自己改文件时，换用 [nawaban](../nawaban/SKILL.md)，按普通任务认领一张卡。

命令写成 `nawaban --db <目标库绝对路径> <动词>`，参数查 `--help`。入口、目标库和会话身份见 [运行入口与身份](../nawaban/references/runtime.md)。

## 六条规矩

1. **主控不改项目文件。** 不写代码，不替 worker 定实现方法。发现要改的东西，建卡或写回已有的卡。
2. **卡只写做什么和怎么算做完。** 不写怎么做。验收条目写不成可观察的结果，就不派，先回去问清需求。
3. **一张卡一个会话，用派发命令起。** 子 agent 只用来查询和评审，不当 worker。
4. **卡是事实源。** 来信和 worker 送回来的话是它自己的说法；下结论前回卡核对状态、refs 和事件。
5. **验收只认板上的证据。** 板上没有的验证当作没做。需要人拍板的事走 ask，等 answer 落板。
6. **只升级三类事：产品语义分叉、对外承诺、生产发布。** 其余自己定。收官前从板上对账，不凭记忆宣布做完。

第 6 条的判据：答案会改变用户看到的行为、对外说出去的话或线上状态，就交给用户；否则主控自己定并记到卡上。

## 拆卡与发卡

需要独立交付、不同 owner 或有先后阻塞时才拆。字段写法见 [建卡与需求边界](../nawaban/references/grill-protocol.md)。

- 子卡用 `create <ID> --title "<标题>" --context "- <背景>" --split-from <父卡> --success '<JSON 数组>' --touch <路径>` 建，批量派发靠这条拆卡关系找子卡。
- 先后顺序用 `link <被挡卡> <前置卡> --kind depends_on` 表达。拆自同一张父卡不等于互相依赖。
- 两张卡的 `touches` 重叠时，要么排先后，要么在卡上写明各自只动哪一部分。
- 子卡要合在一起交付（一个 PR 进 main）时用集成分支：从 main 建 `int/<父卡>` 并推到远端，每张子卡建卡时加 `--constraints '["PR 目标分支：int/<父卡>"]'`。worker 照派单说明，开 PR 前先把目标分支最新提交合进自己的分支。子卡 PR 合进集成分支、集成分支合进 main，都按下文「合并」一节由主控合。

## 派发与收工

在目标仓库里执行：

```bash
nawaban --db <目标库> dispatch <ID>                      # 单张
nawaban --db <目标库> dispatch --parent <父卡> --dry-run  # 只看哪些会派、哪些不派及原因
nawaban --db <目标库> dispatch --parent <父卡>            # 派出待办且前置卡都已完成的子卡
nawaban --db <目标库> dismiss <ID>                       # 卡完成或交接后收工
```

- `dispatch` 起一个以卡号命名的独立会话，给它一个独立工位，把卡的内容作为第一条消息交给它，并把会话编号记到卡上。认领由 worker 进场后自己做。
- 派发起的是 Claude Code 会话，执行派发的机器上要有 `claude` 命令；没有时 `dispatch` 会报会话没起来，这一节和下一节的回话办法都用不了，改由人逐张开工。
- 没有终端复用器也能派：这时会话在后台运行，用 `claude agents` 查看。
- 已被认领、不是待办、前置卡未完成、同名会话还在跑的卡不会派，命令会说出原因。
- `dismiss` 停掉会话并清理工位。工位里还有没提交或没推送的改动时不清理，并说明原因；先让 worker 提交推送，或自己确认这些改动可以丢。
- 子卡报 done 并验收通过后，再跑一次 `dispatch --parent <父卡>`：前置卡刚完成的子卡这时才派得出去。
- 卡验收通过的当轮就收工。活做完了但会话还开着、工位还挂着，算没收尾。

不用 Agent 工具起具名子 agent 当 worker：它没有自己的会话编号，看板记不到它，它的输出还会全部流回主控窗口。

## 来信与回话

worker 用信件汇报阶段、阻塞和完成：

```bash
nawaban --db <目标库> notifications --unread              # 所有未读
nawaban --db <目标库> notifications --unread --task <ID>  # 只看一张卡；卡号要写全，不支持前缀
nawaban --db <目标库> notify-read <信件编号>...            # 处理完标已读
```

worker 每轮停下时，它这一轮的最后一段话也可能被直接送到主控窗口。信件和送回来的话按同一种方式处理：

1. 先回卡核对：`context <ID>` 看状态、当前态、事件和 refs。送回来的话有长度上限，被截断时以卡为准。
2. worker 留了问题，主控能定的当轮就定：`notify <ID> --kind reply --msg "<决定和理由>"`。回话落在卡上，并叫醒 worker 接着干，送达规则见 [Worker 协议](../nawaban/references/director-worker.md)。答复改了验收条目时，另用 `decide --set-success` 落板。用户的回答也由主控转成回话，不要让用户去 worker 的窗口里代答。
   回话只认派它的那个会话。本窗口不是派它的会话（窗口重开过）时，按卡上以 `dispatch` 开头的事件里记的 backend 直接送话：
   - `"backend": "claude-bg"`：在它的工位目录里先 `claude stop <会话编号前 8 位>`，再 `claude --bg --resume <会话编号> "<答复>"`。必须先停再续：会话只是空闲、没停时直接续，会另起一个副本，原来的 worker 收不到。
   - `"backend": "herdr"`：`herdr agent prompt <卡号小写> "<答复>"`。
3. 属于三类升级事项的，不自己回，转给用户（见下节的 ask）。
4. 判断 worker 是否做完，看卡的状态和来信，不看会话是否显示空闲。
5. 范围要扩：worker 说明路径和理由，主控同意后用 `scope <ID> --add <路径> --reason "<理由>"` 落板，worker 才能改。

## 验收与收官

逐条对照卡的 `success`，每条都要在板上找到对应的证据：测试结果、PR、运行记录。分清真实跑过的和只用替身测过的；没验证的条目照实写没验证，退回 worker 补，主控不替它跑。

### 合并

用户已授权：一张卡验收通过、评审没有阻塞问题，主控当轮合并它的 PR，不再问用户。

1. 评审：用子 agent 只读评审 PR 的 diff，或用项目规定的评审；结论用 `event <ID> --kind verify` 记到卡上。有阻塞问题就退回 worker，修完重新评审。
2. 合并：先 `gh pr checks <PR> --watch` 等 CI 全绿；分支落后 main 就 `gh pr update-branch <PR>` 再等一轮。然后把 `gh pr merge <PR> -R <OWNER/REPO>` 作为一条独立命令运行，细节见 [PR 与评审](../nawaban/references/review-pr.md)。
3. 落板：回话告诉 worker 合并的 SHA，让它按 [交付与收尾](../nawaban/references/cards.md) 登记 `merge_sha` 并转 done，再 `dismiss`。

合并会触发生产部署的仓库，合并就是生产发布，改走 `ask --kind authorize`。集成分支合进 main 前，先做完收官第 4 项的整体评审。

需要用户拍板时：

```bash
nawaban --db <目标库> ask --kind decide --question "<一句疑问句>" --evidence "<材料>" --task <ID> --option "<选项>|<后果>" --option "<选项>|<后果>"
nawaban --db <目标库> ask --kind authorize --question "<一句疑问句>" --evidence "<材料>" --task <ID> --blast "<谁受影响>|<改什么>|<怎么回滚>"
nawaban --db <目标库> ask --kind accept --question "<一句疑问句>" --evidence "<读到的实际结果>" --task <ID>
nawaban --db <目标库> inbox                               # 还有哪些没答
nawaban --db <目标库> answer <ask 编号> --verdict "<用户原话>"
```

`decide` 至少两个 `--option`，`authorize` 的 `--blast` 要三段，缺了命令会拒绝。`accept` 的材料要是读到的实际结果，只写「PR 已合并」「CI 绿」会被拒。用户在对话里回答的，由主控用 `answer` 原话写回。`answer` 只记下决定，不替人执行；它提示还要跑 `fanout <ask 编号> --ok|--failed` 时，等被授权的动作真的做完再跑。

宣布收官前，四项都查一遍：

1. `dispatch --parent <父卡> --dry-run` 列出每张子卡的当前状态，没有还在做或没人做的卡。
2. 对每张子卡跑 `notifications --unread --task <子卡号>`，都为空。库里别的卡的未读信不归本批管，不替别人标已读。
3. `inbox` 里没有本批卡的未答提问。
4. 本批改动合在一起评审过：用子 agent 评审集成分支（没用集成分支时是本批各 PR）相对 main 的整体 diff，只找跨卡的问题。发现的问题已建卡或写回对应子卡，并已处理完。

有一项不满足就不宣布，向用户报告剩下的是什么。全部满足后，对每张已派出的卡跑过 `dismiss`，再向用户汇报：每张卡一行，写状态、证据指针和没验证的部分。
