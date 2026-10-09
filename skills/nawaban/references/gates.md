# 状态与 hook 闸

被拒后先读工具给出的原因，核对目标板、owner、状态与缺少的事实。修正实际前置条件，保留项目授权边界。

| 闸 | 触发条件 | 合法处理 |
|---|---|---|
| maintree hook | 在共享主树修改项目文件；命令行写入的相对路径按会话目录判断，不跟命令里的 `cd` | 在本卡 worktree 实施，命令行写文件用 worktree 内的绝对路径；hook 的豁免不改变授权 |
| merge hook | `gh pr merge` 与其他命令串接、带管道或重定向、带变量或环境变量前缀；PR checks 为空或未全绿；PR 分支落后 main | 单独运行 `gh pr merge <PR> -R <OWNER/REPO>`；落后时先 `gh pr update-branch <PR>`，等新一轮 CI 全绿再合 |
| branch hook | 在主树新建或切换任务分支 | 创建独立 worktree，保持主树 main；修复错误分支按项目恢复程序 |
| claim 依赖 | depends_on 前置未 done/cancelled | 核对前置并先完成依赖；只有项目授权覆盖时才用带理由的 override |
| claim 停线 | 本项目 main CI 红着，且变红后没有未完成的 regresses 修复卡 | `nawaban blame <失败的文件>` 找到被弄坏的 done 卡，建修复卡并 `link <修复卡> <被弄坏的卡> --kind regresses --note "<哪次合并>"`；与回退无关的红(基础设施、偶发)才用带理由的 override |
| start | 卡不是 claimed 或 owner 不匹配 | 核对是否已开始、被回收或由其他 owner 持有，按真实状态续做 |
| staging-verified / done | 缺证据或有效决策、状态转换不合法 | 按 [交付与收尾](cards.md) 补真实证据，参数用 CLI 帮助确认 |

库层校验由 CLI 实施，编辑与分支保护需要调用方实际安装对应 hooks。touches 冲突为 WARN；旧 grill/design/flag、Markdown done-gate 不属于现行 DB 保护。

源码依据：`$NAWABAN_HOME/nawaban/db.py`、`nawaban/guard.py` 与 `hooks/foreman_branch_gate.py`；相关回归见项目 `tests/upstream/` 下的 `test_workos_db.py`、`test_workos_guard.py`、`test_branch_gate.py`。只检查实际遇到的闸，不需要为了普通改动遍历全部实现。
