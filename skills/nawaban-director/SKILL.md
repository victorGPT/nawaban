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
2. worker 留了问题，主控能定的当轮就定：先用 `decide` 把答复记到卡上，再把答复送进它的会话，它才会接着干。不要让用户去 worker 的窗口里代答。卡上以 `dispatch` 开头的事件记着它是怎么起的：
   - `"backend": "claude-bg"`：在它的工位目录里先 `claude stop <会话编号前 8 位>`，再 `claude --bg --resume <会话编号> "<答复>"`。必须先停再续：会话只是空闲、没停时直接续，会另起一个副本，原来的 worker 收不到。
   - `"backend": "herdr"`：`herdr agent prompt <卡号小写> "<答复>"`。
3. 属于三类升级事项的，不自己回，转给用户（见下节的 ask）。
4. 判断 worker 是否做完，看卡的状态和来信，不看会话是否显示空闲。
5. 范围要扩：worker 说明路径和理由，主控同意后用 `scope <ID> --add <路径> --reason "<理由>"` 落板，worker 才能改。

## 验收与收官

逐条对照卡的 `success`，每条都要在板上找到对应的证据：测试结果、PR、运行记录。分清真实跑过的和只用替身测过的；没验证的条目照实写没验证，退回 worker 补，主控不替它跑。

需要用户拍板时：

```bash
nawaban --db <目标库> ask --kind decide --question "<一句疑问句>" --evidence "<材料>" --task <ID> --option "<选项>|<后果>" --option "<选项>|<后果>"
nawaban --db <目标库> ask --kind authorize --question "<一句疑问句>" --evidence "<材料>" --task <ID> --blast "<谁受影响>|<改什么>|<怎么回滚>"
nawaban --db <目标库> ask --kind accept --question "<一句疑问句>" --evidence "<读到的实际结果>" --task <ID>
nawaban --db <目标库> inbox                               # 还有哪些没答
nawaban --db <目标库> answer <ask 编号> --verdict "<用户原话>"
```

`decide` 至少两个 `--option`，`authorize` 的 `--blast` 要三段，缺了命令会拒绝。`accept` 的材料要是读到的实际结果，只写「PR 已合并」「CI 绿」会被拒。用户在对话里回答的，由主控用 `answer` 原话写回。`answer` 只记下决定，不替人执行；它提示还要跑 `fanout <ask 编号> --ok|--failed` 时，等被授权的动作真的做完再跑。

宣布收官前，三项都从板上查一遍：

1. `dispatch --parent <父卡> --dry-run` 列出每张子卡的当前状态，没有还在做或没人做的卡。
2. 对每张子卡跑 `notifications --unread --task <子卡号>`，都为空。库里别的卡的未读信不归本批管，不替别人标已读。
3. `inbox` 里没有本批卡的未答提问。

有一项不满足就不宣布，向用户报告剩下的是什么。全部满足后，对每张已派出的卡跑过 `dismiss`，再向用户汇报：每张卡一行，写状态、证据指针和没验证的部分。
