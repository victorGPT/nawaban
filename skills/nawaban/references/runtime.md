# 运行入口、数据与身份

## 找到实现

从已核实的 nawaban 源码仓运行 `python3 "$NAWABAN_HOME/nawaban/cli.py" <动词>`，参数查 `--help`。本 Skill 真实路径为 `<nawaban 根>/skills/nawaban/SKILL.md`；先解析符号链接，再沿目录找到该根。需要短命令时，只为当前执行进程定义：

```bash
export NAWABAN_HOME="<已核实的 nawaban 根绝对路径>"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

作为 Claude Code 插件安装时，`NAWABAN_HOME` 取插件根目录（钩子进程里的 `CLAUDE_PLUGIN_ROOT`）。`NAWABAN_HOME` 用于找到源码与可选 helpers，不选择任务数据库。需要安装或配置 hooks 时才读 [安装与集成](../../../README.md#install-as-a-plugin)。安装不足时说明缺少的入口；普通任务不会自动改全局配置。

## 选择目标板

项目声明的任务库是事实来源。CLI 优先级是显式 `--db` → `NAWABAN_DB` → Git 共享主树的 `.nawaban/nawaban.db`（不存在时回退 `.foreman/workos.db`）→ 当前目录向上查找的板目录。跨项目或安装目录调用时使用 `--db <目标库绝对路径>`，避免误连安装项目自己的板。

多个项目共用一份库时，建卡显式传 `--project <项目名>`；未指定时优先按当前仓库板目录的所属目录名推导，再回退显式数据库的板目录，拆卡继承父卡项目。Web 项目筛选只选择当前展示范围，不会切换数据库。

当前卡与数据库结构可通过现有 Web/API 或 SQLite `mode=ro` 读取；查询前按需要查看 schema。CLI 没有 `show` 动词。多数 CLI 动词会先执行 schema 升级，严格只读检查用只读连接；`--help` 不打开数据库。

任务写入经 CLI，数据库和个人状态保持本地私有。仅显式接入新板时使用 `init`；找不到旧库先查路径。验证、演练与 SessionStart smoke 使用独立临时库和测试身份，SessionStart 会回收任务，不能拿真实板做演练。

## 会话身份

写操作实际传入运行环境提供的 `NAWABAN_OWNER` 与 `CLAUDE_CODE_SESSION_ID`。CLI owner 取前者，否则由 session 派生 `ac:<完整 session ID>`；需要 session 的动词缺少后者会拒绝。CLI 本身不自动读取 tmux 窗口名。

恢复时用卡的 sessions、handoff 和工位确认任务归属；恢复已有会话沿用它的身份，新会话使用新的真实身份。Claude Code 会话可在原 cwd 执行 `claude --resume <session-id>`；其他执行器按其恢复能力操作。

旧配置的兼容回退约定见仓库根 `CHANGELOG.md`；`init` 的新建默认路径为 `.nawaban/nawaban.db`。
