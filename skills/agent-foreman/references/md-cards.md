# 历史 Markdown 卡

当前事实来源与接入步骤见 [foreman-pattern](../../foreman-pattern/SKILL.md)。库层闸随 CLI 生效，编辑 hooks 必须另行配置；创建数据库本身不安装 hooks。

Markdown 轨已经退役，仅用于理解存量材料。旧卡通常位于 `.foreman/tasks/` 或项目声明的归档目录，frontmatter 保存当时状态，正文保存对齐与时间线。模板见 [TEMPLATE.md](../../foreman-pattern/TEMPLATE.md)。

读取历史卡时保留原始语义，不据此推断当前 DB 状态。需要导入时先使用 `python3 "$WORKOS_HOME/src/workos/import_md.py" --help` 核对参数，在临时库 dry-run 和验证；对真实库 apply 必须有相应授权。已退役的 `foreman_claim_check.py`、Markdown done-gate 与手工移动卡片命令不是当前工作流。
