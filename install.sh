#!/bin/sh
set -eu

PACKAGE_URL="${YAOGUO_INSTALL_PACKAGE_URL:-https://github.com/lhenlihai-hub/yaoguo/archive/refs/heads/main.tar.gz}"
MINIMUM_NODE="22.19.0"
INSTALL_ROOT="${YAOGUO_INSTALL_ROOT:-${HOME}/.yaoguo}"
PREFIX="${INSTALL_ROOT}/app"
COMMAND_DIR="${YAOGUO_COMMAND_DIR:-${HOME}/.local/bin}"
PROFILE=""
PROFILE_BLOCK_START="# >>> yaoguo >>>"
PROFILE_BLOCK_END="# <<< yaoguo <<<"

say() {
  printf '%s\n' "$1"
}

fail() {
  printf '安装失败：%s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先安装 Node.js 22.19.0 或更高的 Node 22 版本。"
command -v npm >/dev/null 2>&1 || fail "未找到 npm，请先安装完整的 Node.js。"

node -e '
const current = process.versions.node.split(".").map(Number);
const minimum = process.argv[1].split(".").map(Number);
const valid = current[0] === 22 && current.some((part, index) => part > minimum[index] && current.slice(0, index).every((value, i) => value === minimum[i]))
  || current.every((part, index) => part === minimum[index]);
if (!valid) process.exit(1);
' "$MINIMUM_NODE" || fail "当前 Node.js 为 $(node -v)，需要 22.19.0 或更高的 Node 22 版本。"

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) fail "当前只支持 macOS 和 Linux。" ;;
esac

mkdir -p "$PREFIX/lib/node_modules" "$PREFIX/bin" "$COMMAND_DIR"

for COMMAND in yaoguo 腰果; do
  LINK="$COMMAND_DIR/$COMMAND"
  TARGET="$PREFIX/bin/$COMMAND"
  if [ -L "$LINK" ]; then
    EXISTING_TARGET="$(readlink "$LINK")"
    [ "$EXISTING_TARGET" = "$TARGET" ] || fail "命令已被其他程序占用：$LINK"
  elif [ -e "$LINK" ]; then
    fail "命令已被其他程序占用：$LINK"
  fi
done

say "正在安装腰果…"
npm install --global --prefix "$PREFIX" --omit=dev --no-audit --no-fund --loglevel=error "$PACKAGE_URL"

for COMMAND in yaoguo 腰果; do
  LINK="$COMMAND_DIR/$COMMAND"
  TARGET="$PREFIX/bin/$COMMAND"
  [ -L "$LINK" ] || ln -s "$TARGET" "$LINK"
done

PATH_READY=false
case ":$PATH:" in
  *":$COMMAND_DIR:"*) PATH_READY=true ;;
esac

if [ "$PATH_READY" = false ]; then
  PROFILE="${HOME}/.profile"
  case "${SHELL:-}" in
    */zsh) PROFILE="${HOME}/.zprofile" ;;
    */bash) PROFILE="${HOME}/.bash_profile" ;;
  esac
  if [ ! -f "$PROFILE" ] || ! grep -F "$PROFILE_BLOCK_START" "$PROFILE" >/dev/null 2>&1; then
    {
      printf '\n%s\n' "$PROFILE_BLOCK_START"
      printf 'export PATH="%s:$PATH"\n' "$COMMAND_DIR"
      printf '%s\n' "$PROFILE_BLOCK_END"
    } >> "$PROFILE"
  fi
fi

node -e '
const fs = require("node:fs");
const [file, installRoot, appPrefix, commandDir] = process.argv.slice(1);
const manifest = {
  kind: "yaoguo.install",
  version: 1,
  installRoot,
  appPrefix,
  runtimeRoot: `${installRoot}/runtime`,
  artifactRoot: `${installRoot}/artifacts`,
  commandLinks: [`${commandDir}/yaoguo`, `${commandDir}/腰果`]
};
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
' "$INSTALL_ROOT/install.json" "$INSTALL_ROOT" "$PREFIX" "$COMMAND_DIR"

"$COMMAND_DIR/yaoguo" --version >/dev/null
say "腰果已安装。"
if [ "$PATH_READY" = true ]; then
  say "运行：腰果"
else
  say "新建终端后运行：腰果"
  say "若要在当前终端立即使用，请先执行：export PATH=\"$COMMAND_DIR:\$PATH\""
fi
say "卸载：腰果 uninstall"
