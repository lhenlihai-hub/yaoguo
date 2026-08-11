#!/bin/sh
set -eu

PACKAGE_URL="${YAOGUO_INSTALL_PACKAGE_URL:-https://github.com/lhenlihai-hub/yaoguo/archive/refs/heads/main.tar.gz}"
MINIMUM_NODE="22.19.0"
FALLBACK_PREFIX="${HOME}/.local"

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

DEFAULT_PREFIX="$(npm config get prefix)"
PREFIX="$DEFAULT_PREFIX"
if ! mkdir -p "$DEFAULT_PREFIX/lib/node_modules" "$DEFAULT_PREFIX/bin" 2>/dev/null \
  || [ ! -w "$DEFAULT_PREFIX/lib/node_modules" ] \
  || [ ! -w "$DEFAULT_PREFIX/bin" ]; then
  PREFIX="$FALLBACK_PREFIX"
  mkdir -p "$PREFIX/lib/node_modules" "$PREFIX/bin"
fi

say "正在安装腰果…"
npm install --global --prefix "$PREFIX" --omit=dev --no-audit --no-fund --loglevel=error "$PACKAGE_URL"

BIN_DIR="$PREFIX/bin"
PATH_READY=false
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_READY=true ;;
esac

if [ "$PATH_READY" = false ]; then
  PROFILE="${HOME}/.profile"
  case "${SHELL:-}" in
    */zsh) PROFILE="${HOME}/.zprofile" ;;
    */bash) PROFILE="${HOME}/.bash_profile" ;;
  esac
  MARKER="# 腰果命令"
  if [ ! -f "$PROFILE" ] || ! grep -F "$MARKER" "$PROFILE" >/dev/null 2>&1; then
    {
      printf '\n%s\n' "$MARKER"
      printf 'export PATH="%s/bin:$PATH"\n' "$PREFIX"
    } >> "$PROFILE"
  fi
fi

"$BIN_DIR/yaoguo" --version >/dev/null
say "腰果已安装。"
if [ "$PATH_READY" = true ]; then
  say "运行：腰果"
else
  say "新建终端后运行：腰果"
  say "若要在当前终端立即使用，请先执行：export PATH=\"$BIN_DIR:\$PATH\""
fi
