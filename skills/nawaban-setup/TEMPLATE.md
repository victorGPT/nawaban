<!-- Historical Markdown workflow reference; current tasks use nawaban DB. -->
---
task_id: CORE-001
status: open            # open → claimed → in_progress → staging-verified → done · 单字段非完整态:连读 pr:(open+pr=代码在PR待合)与 waiting_on:(verified+observe=路径已验·效果待观察)
outcome:                # 可选 flag(非状态) · 废弃留痕:canceled / superseded · 移 done/ 时标+notes 写原因
epic:                   # 可选 · 大需求归组标签(一个 plan 拆 ≥3 卡时全部带同一 epic) · 看板按它聚合
owner: window-1         # 稳定短标签;claim 时写(NAWABAN_OWNER / tmux #S:#W / session-id 派生) · 不许匿名
adr:                    # 可选 · 关联决策指针 · 开工前先读它
design:                 # 多方时序卡必填(设计闸):设计对齐笔记指针;确无多方时序填 n/a·<一句理由>
grill:                  # 非平凡卡必填(grill 闸·epic/跨≥2模块):grilling 对齐记录指针(epic 成员卡指同一份);平凡卡填 n/a·<一句理由>
capability:             # 可选·功能归属指针:指该功能的当前态档(如 docs/capabilities/<x>.md);无档填 <功能名>·无档 · 回答"这张卡围绕哪个功能"
pr:                     # 可选 · 关联 PR 号
touches:                # ★软锁:要改的文件/目录 · guard 按此判冲突
  - app/core/
success:                # ★SDD·什么算完成:可验证判据 · 测试用例与验收报告逐条对照它
  - <用户可观察的行为 1>
constraints:            # SDD·底线:绝不能做什么 · 跨卡共享的不变量写指针(指 design/adr)别抄件 · 无则删
sessions:               # append-only 履历:owner | session-id | 日期(claim 时追加 · 接力新增一行)
handoff:                # append-only 交接:<日期> <owner> | done X · 剩 Y · 下一步看 file:line(≤1行/次)
acceptance:             # 验收证据指针一行 · 翻 staging-verified 时 guard 硬校验非空;纯内部改动填「纯内部·CI收口」(done 闸豁免值)
staging_verified_at:    # 翻 staging-verified 时写 ISO 时间(催办锚点·本包无消费者,全流程 Loop 用)
waiting_on:             # verified 时必填:decision=等拍板(唯一该催) / prod / observe / external
notes: 一句执行结论      # 永远只一句当前态 · 细节下沉「## 时间线」,别堆叙事别前插
---
# CORE-001 · 标题（人看的正文 · 机器只动 frontmatter 不改 body）

## 对齐
<!-- grill 决策树摘要:每分叉一行「问题 → 拍板 + 被否选项(为何否)」· 被否项必留 · 不抄 transcript;
     拍板被实证推翻 → 追加日期行「验证闸触发(<日期>):<实证> · 改走 <预案>」,不覆写原行 -->
- <分叉 1 → 拍板 Y · 否了 X(理由)>

## 范围
- 做:<到哪里为止>
- 不做:<明确排除的相邻功能>
- 依赖:<blocked by 哪张卡 · 无则删>

## 时间线
<!-- append-only · 最新在顶 · `- <日期> <owner> | <事件>` · 一事一行绝不合并;协调记录带「协调:」前缀。
     接手读法:最新非协调行=最近实质状态。唯一允许任何 owner 追加的 body 区块 -->
- <日期 owner | 事件>

复制到 `.foreman/tasks/<域>/active/<task_id>.md` 改 frontmatter 即用。
- 切片判据(tracer-bullet):每卡贯穿全层、独立可 demo、单 context window 装得下。
- 冷启动契约:进度+下一步反映 origin/main 当前真值(已合并带 merge SHA);拿不到的 live 态标「须实查」。
  新鲜 > 详细 · 指针 > 描述 · 诚实标洞 > 伪装完整。
- guard 只在 status ∈ {claimed, in_progress} 时对 touches 生效;目录写法末尾带 `/`。
