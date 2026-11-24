#!/bin/sh
set -eu
mods="${HERDR_MODS_DIR:-$HOME/.config/herdr-app/mods}"
[ -d "$mods" ] || exit 0
mkdir -p "$mods/nawaban-board"
cp -R "$(cd "$(dirname "$0")" && pwd)/mods/nawaban-board/." "$mods/nawaban-board/"
