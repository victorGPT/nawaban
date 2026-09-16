# 运行入口、数据与身份

## 找到实现

已安装的 `workos` 是首选入口，参数查 `workos <动词> --help`。CLI 不在 PATH 时，定位已知 WorkOS 源码安装：本 Skill 真实路径为 `<WorkOS 根>/skills/agent-foreman/SKILL.md`；先解析符号链接，再沿目录找到该根。确认其中 `.venv/bin/workos` 可运行后，用绝对路径调用，或只为当前执行进程设置：

```bash
export WORKOS_HOME="<已核实的 WorkOS 根绝对路径>"
export PATH="$WORKOS_HOME/.venv/bin:$PATH"
```

`WORKOS_HOME` 用于找到源码与可选 helpers，不选择任务数据库。需要安装或配置 hooks 时才读 [安装与集成](../../../integrations/README.md)。安装不足时说明缺少的入口；普通任务不会自动改全局配置。

## 选择目标板

项目声明的任务库是事实来源。CLI 优先级是显式 `--db` → `WORKOS_DB` → Git 共享主树的 `.foreman/` → 当前目录向上查找的 `.foreman/`。跨项目或安装目录调用时使用 `--db <目标库绝对路径>`，避免误连安装项目自己的板。

当前卡与数据库结构可通过现有 Web/API 或 SQLite `mode=ro` 读取；查询前按需要查看 schema。CLI 没有 `show` 动词。多数 CLI 动词会先执行 schema 升级，严格只读检查用只读连接；`--help` 不打开数据库。

任务写入经 CLI，数据库和个人状态保持本地私有。仅显式接入新板时使用 `init`；找不到旧库先查路径。验证、演练与 SessionStart smoke 使用独立临时库和测试身份，SessionStart 会回收任务，不能拿真实板做演练。

## 会话身份

写操作实际传入运行环境提供的 `FOREMAN_OWNER` 与 `CLAUDE_CODE_SESSION_ID`。CLI owner 取前者，否则由 session 派生 `ac:<前 8 位>`；需要 session 的动词缺少后者会拒绝。CLI 本身不自动读取 tmux 窗口名。

恢复时用卡的 sessions、handoff 和工位确认任务归属；恢复已有会话沿用它的身份，新会话使用新的真实身份。Claude Code 会话可在原 cwd 执行 `claude --resume <session-id>`；其他执行器按其恢复能力操作。
