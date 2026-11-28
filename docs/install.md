# Installation

## Without Herdr: one command (macOS)

You need macOS, Node 22.18 or later, pnpm, git, and Claude Code logged in. Run:

```sh
git clone https://github.com/victorGPT/nawaban ~/.nawaban/plugin && ~/.nawaban/plugin/install.sh
```

`install.sh` builds the board and its web page, installs the Claude Code plugin `nawaban@nawaban`, writes `nawaban` to `~/.local/bin`, sets up the [Codex sandbox](#codex-sandbox) when `codex` is on your `PATH`, and starts the launchd agent `com.nawaban.board` on `127.0.0.1:4100`. To update, run `git -C ~/.nawaban/plugin pull --ff-only && ~/.nawaban/plugin/install.sh`.

- For a trial install beside an existing one, set `NAWABAN_BOARD_DIR`, `NAWABAN_BOARD_PORT`, `NAWABAN_LAUNCHD_LABEL` and `NAWABAN_BIN_DIR`. Start Claude Code with the same `NAWABAN_BOARD_DIR` and `NAWABAN_BOARD_PORT`, because the hooks read them from its environment.
- The log is `~/.nawaban/board/serve.log`. Restart with `launchctl kickstart -k gui/$(id -u)/com.nawaban.board`.

### First use

1. In your project, start a Claude Code session and type `/nawaban:orchestrator`. Do it again after a new session or `/clear`.
2. Run `nawaban web` to open the page with its token. On `401`, run it again.

## With Herdr

Paste this into your agent in the project:

```text
Install nawaban by following https://github.com/victorGPT/nawaban/blob/main/docs/install.md and create a board in this project.
```

## For the agent doing the install

Each step is safe to rerun. If one fails, stop and tell the user.

1. Check that `git` and `pnpm` exist and that `node --version` is 22.18 or later.
2. If `~/nawaban` is a nawaban checkout, run `git -C ~/nawaban pull --ff-only`. Otherwise run `git clone https://github.com/victorGPT/nawaban ~/nawaban`.
3. Install the plugin for your agent as [Plugin install](#plugin-install) says, with `~/nawaban` as the path.
4. Run `pnpm --dir ~/nawaban/board install --frozen-lockfile`. The board lives in `~/.nawaban/board/`.
5. Tell the user to start a new session so the `nawaban` skill loads, and to add the [Herdr panel](#herdr-panel).

Add `nawaban() { node ~/nawaban/board/src/cli.ts "$@"; }` to the shell profile only if the user asks.

## Plugin install

The checkout is a Claude Code, Codex and Antigravity plugin. Codex runs its hooks only after you trust each one in `/hooks`.

- **Claude Code:** `claude plugin marketplace add /path/to/nawaban`, then `claude plugin install nawaban@nawaban`. Start a new session after a pull. To develop nawaban, use a separate clone ([release](release.md)).
- **From GitHub:** `claude plugin marketplace add victorGPT/nawaban`, then `claude plugin install nawaban@nawaban`. To update, run `claude plugin marketplace update nawaban && claude plugin update nawaban@nawaban`.
- **Codex:** add this to `~/.codex/config.toml`, then run `codex plugin add nawaban@nawaban`. Run it again after each pull, because Codex copies the plugin.

  ```toml
  [marketplaces.nawaban]
  source_type = "local"
  source = "/path/to/nawaban"

  [plugins."nawaban@nawaban"]
  enabled = true
  ```

- **Antigravity:** run these after each pull. The copy breaks pnpm's links, so the board CLI fails with `Cannot find package 'zod'` until you reinstall.

  ```sh
  agy plugin install /path/to/nawaban
  rm -rf ~/.gemini/config/plugins/nawaban/board/node_modules
  pnpm --dir ~/.gemini/config/plugins/nawaban/board install --frozen-lockfile
  ```

### Codex sandbox

Without these settings the CLI fails with `the board didn't answer: fetch failed`, and `claim` exits 1 with `EPERM` on its lease file. Add to `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/Users/<you>/.config/board"]
```

`install.sh` adds this table when the config has none. If a table exists, it prints the two lines to add.

### Antigravity permissions

Add this to `~/.gemini/antigravity-cli/settings.json`, or `agy -p` denies each board command:

```json
{ "permissions": { "allow": ["command(node)"] } }
```

## Run from a checkout

```sh
export NAWABAN_HOME="$(pwd)"
pnpm --dir "$NAWABAN_HOME/board" install --frozen-lockfile
nawaban() { node "$NAWABAN_HOME/board/src/cli.ts" "$@"; }
```

All projects share the board in `NAWABAN_BOARD_DIR` (default `~/.nawaban/board/`). `nawaban backup` copies `local.db` into `backups/`.

## Session identity

Writes take the identity from `CODEX_THREAD_ID`, then `ANTIGRAVITY_CONVERSATION_ID`, then `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`, then the OS user. Outside these agents, set `NAWABAN_OWNER` to a stable name.

## Herdr panel

The panel needs the checkout at `~/nawaban` with `pnpm install` done in `board/`, on every machine whose spaces it shows. Copy the mod, because Herdr does not reload a symlink. Copy it again after each pull.

```sh
cp -R ~/nawaban/herdr/mods/nawaban-board ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/nawaban-board
```

Bind a key in the `global` section of `~/.config/herdr-app/keys.json`:

```json
"global": { "cmd-shift-j": "mod.open:nawaban-board" }
```

To dock the panel instead, add a block `{ "id": "nawaban", "type": "block", "hidden": true, "size": { "px": 420 }, "content": { "mod": "nawaban-board" } }` to a layout you own, and bind `layout.toggle:nawaban` in that layout's `keys.json` section.

## Web page

`nawaban serve` serves the page at `http://127.0.0.1:4100/`, and `nawaban web` opens it with the token from `~/.nawaban/board/web-token`. After a pull that changes `web/`, run `pnpm --dir ~/nawaban/web install --frozen-lockfile && pnpm --dir ~/nawaban/web build`.

### From your phone over Tailscale

1. Run `tailscale serve --bg 4100`. It prints a host such as `mymac.tail0000.ts.net`.
2. Write the host without `https://` into `~/.nawaban/board/tailnet` and restart the board.
3. Run `nawaban web --tailnet` and open its link on your device. Keep the link private.

To turn it off, run `tailscale serve --https=443 off`, delete `~/.nawaban/board/tailnet`, and restart the board.
