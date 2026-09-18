# 捕捉想法

侧栏的「捕捉」是独立队列。想法不是任务，不进入看板列、不计入任务数，也不会生成模块、依赖或待拍板事项。记录只需一句想法；选择具体项目时归到该项目，在「全部项目」或「无项目」下记录则保持未归属。

默认显示待处理；「查看处理记录」包含已转卡与已作废条目。已转卡条目能打开正式卡，正式卡详情的「来自捕捉」保留原始想法和编号。作废保留原因，不删除历史。

## Agent 处理

所有命令显式使用同一个目标库；写操作沿用当前会话身份。捕捉不是任务，不能 claim/start，也不触发建卡建议。

```bash
python3 nawaban/cli.py --db /absolute/path/board.db capture list
python3 nawaban/cli.py --db /absolute/path/board.db capture list --project workos
python3 nawaban/cli.py --db /absolute/path/board.db capture add --content '希望随手记录想法' --project workos
```

读完一条后必须作出一种处理：

1. 整理背景与要做的事、成功判据和约束，通过现有 `create` 建立正式卡；该流程保留现有内容检查、幻觉闸、模块建议和前置建议。随后关联它：

   ```bash
   python3 nawaban/cli.py --db /absolute/path/board.db capture convert CAPTURE_UUID --task TASK_ID
   ```

2. 无需形成任务时作废，写明原因：

   ```bash
   python3 nawaban/cli.py --db /absolute/path/board.db capture discard CAPTURE_UUID --reason '已由另一项需求覆盖'
   ```

`convert` 只关联库中已有卡，不代替 `create`，不会创建任务、补写任务字段或自动连依赖边。建卡成功但关联尚未完成时，复用已有卡再执行 `convert`，不要重复建卡。

回看全部记录用 `capture list --status all`；从正式卡查来源用 `capture list --task TASK_ID`。列表输出 JSON，包含捕捉编号、内容、状态、项目、处理结果及时间和操作者。

## 存储与重试

仅新增 `captures` 表及其索引，不改变现有表结构。首次由新版 CLI 写入时执行增量迁移；只读看板不迁移，旧库尚无捕捉表时返回空队列。部署前在目标库副本运行迁移验证。

浏览器沿用当前看板的同源与 Host 校验，写入经 CLI 子进程。浏览器只能记录想法，处理结果由 CLI 写入；捕捉不会代表人的批准或验收。开发服务器代理对捕捉采用相同的原始 Origin 校验。

每次保存用独立 UUID 作为重试键；相同 ID、内容、项目与创建者重试返回原记录，材料冲突则拒绝。响应丢失时界面锁住原材料，允许重试同一个请求。创建与处理均在事务内；同一处理结果可以重复确认，已转卡或已作废后不能改写为其他结果。

尚未点击保存的草稿只保留在当前视图内；切换项目、离开捕捉页或刷新页面会清空草稿。已确认保存的捕捉保留在数据库中。
