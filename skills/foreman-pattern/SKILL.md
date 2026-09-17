---
name: foreman-pattern
description: 将 nawaban 接入一个项目，配置任务库、Web 和所需 hooks；已有板的日常任务用 nawaban。
metadata:
  version: "3.0.0"
---

# nawaban 项目接入

完成条件：目标项目使用明确的一份任务库，所需 CLI/Web 入口可运行，只有实际接线并验证的集成被报告为已生效。

## 接入目标项目

先确认用户要接入的项目、已有任务库和需要的入口。沿用已有安装和数据库；缺安装时按 [安装与集成](../../README.md#install-as-a-plugin) 处理，CLI、数据寻址和身份约定见 [运行入口与身份](../nawaban/references/runtime.md)。相对链接按本 Skill 的真实路径解析。

新板在目标项目共享主树创建：

```bash
nawaban --db <目标项目主树>/.nawaban/nawaban.db init
```

已有板直接引用；迁移已有数据是独立的数据操作，需要覆盖迁移的授权、备份和恢复方案。`.nawaban/` 与兼容旧板的 `.foreman/` 保持本地私有；Git 项目用 `git rev-parse --git-path info/exclude` 定位本地排除文件，补齐缺少的排除规则。

用户需要 Web 时启动 `python3 "$NAWABAN_HOME/nawaban/board_view.py" --db <目标库绝对路径>`，使用可用端口。确认所访问首页和任务 API 属于该项目。Web 默认 localhost，访问权限包含收件箱操作权限；跨设备接入需要明确的信任边界。

## 只接所需集成

- 需要 Agent 技能时，按安装说明启用插件中的 `nawaban`、`foreman-pattern`、`nawaban-wrapup` 三个技能；手动接入时保留目录之间的相对资源路径。
- 需要编辑与分支约束时，读 [Claude Code 与 Codex hooks](../../README.md#install-as-a-plugin)。库层状态校验随 CLI 生效，编辑/分支保护依赖实际安装 hooks；[闸表](../nawaban/references/gates.md) 用于排查。
- Herdr、GitHub、CI 和部署 helpers 按项目需要配置；接入 nawaban 不自动启用它们，也不授权外部消息或部署。
- 仅在读取历史 Markdown 卡时读 [历史轨说明](../nawaban/references/md-cards.md)；[TEMPLATE.md](TEMPLATE.md) 与 [BOARD.md](BOARD.md) 不用于新建当前事实。

## 验证后交付

演练写入用临时库与测试身份；目标已有库通过只读检查核对。SessionStart 有回收副作用，真实库上不能拿它做 smoke。

报告已接通的入口、目标数据库、实际验证与剩余依赖。新项目接入不要求凭空创建业务任务；用户已有待执行任务时再用 [nawaban](../nawaban/SKILL.md) 建卡或认领。
