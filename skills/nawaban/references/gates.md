# 状态与 hook 闸

被拒后先读工具给出的原因，核对目标板、owner、状态与缺少的事实。修正实际前置条件，保留项目授权边界。

| 闸 | 触发条件 | 合法处理 |
|---|---|---|
| maintree hook | 在共享主树修改项目文件 | 在本卡 worktree 实施；hook 的豁免不改变授权 |
| branch hook | 在主树新建或切换任务分支 | 创建独立 worktree，保持主树 main；修复错误分支按项目恢复程序 |
| claim 依赖 | depends_on 前置未 done/cancelled | 核对前置并先完成依赖；只有项目授权覆盖时才用带理由的 override |
| start | 卡不是 claimed 或 owner 不匹配 | 核对是否已开始、被回收或由其他 owner 持有，按真实状态续做 |
| staging-verified / done | 缺证据或有效决策、状态转换不合法 | 按 [交付与收尾](cards.md) 补真实证据，参数用 CLI 帮助确认 |
| PR helper 删除行确认 | 变更相对基线包含删除行 | 检查每项删除属于本次变更，再使用脚本确认参数；陈旧基线先对齐 |

库层校验由 CLI 实施，编辑与分支保护需要调用方实际安装对应 hooks。touches 冲突为 WARN；旧 grill/design/flag、Markdown done-gate 不属于现行 DB 保护。

源码依据：`$NAWABAN_HOME/nawaban/db.py`、`nawaban/guard.py` 与 `hooks/foreman_branch_gate.py`；相关回归见项目 `tests/test_nawaban_db.py`、`test_nawaban_guard.py`、`test_branch_gate.py`。只检查实际遇到的闸，不需要为了普通改动遍历全部实现。
