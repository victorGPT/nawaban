# 占用协调

claim 的 touches 冲突是 WARN，不是互斥锁或编辑授权。同路径并行可能在合并时冲突；核对对方卡、工作区与实际进展，协调顺序。存活探测失败或窗口关闭不能证明对方工作已完成。

独立调用可选检查器时传目标项目共享主树：

```bash
python3 "$NAWABAN_HOME/nawaban/claim_check.py" <目标文件> --owner <本会话owner> --repo <共享主树>
```

该 helper 检查 `--repo/.nawaban/nawaban.db`（新库不存在时兼容旧板），不接受 CLI 的 `--db`；自定义库或跨项目情况下以实际目标板查询为准。它的“无占用”不能覆盖另一个数据库。

## 修改范围

已授权扩界在编辑前落板：

```bash
nawaban --db <目标库> scope <ID> --add <路径> --reason "<已授权的范围扩展原因>"
```

收窄陈旧 touches 前，核对卡状态、实际交付版本和对方工位对应文件的差异，依项目协调规则操作；未知 WIP 保留。命令为：

```bash
nawaban --db <目标库> release <ID> --drop <路径> --reason "<核实后的收窄理由>"
```

`release` 只收窄 touches，不释放 owner。转交 owner 使用 handoff 的 `--release`，语义见 [收尾](cards.md)。工具允许修改不等于已有修改他人范围的授权。
