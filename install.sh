#!/bin/sh
set -eu

PACKAGE_URL="${YAOGUO_INSTALL_PACKAGE_URL:-}"
RELEASE_COMMIT=""
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

if [ -z "$PACKAGE_URL" ]; then
  say "正在检查最新稳定版…"
  RELEASE_COMMIT="$(node -e '
const endpoint = "https://api.github.com/repos/lhenlihai-hub/yaoguo/actions/workflows/check.yml/runs?branch=main&event=push&status=success&per_page=1";
(async () => {
  let failure;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "yaoguo-installer" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const commit = `${(await response.json())?.workflow_runs?.[0]?.head_sha || ""}`;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("没有通过完整测试的版本");
      process.stdout.write(commit);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
})().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
});
')" || fail "无法取得最新稳定版，请检查网络后重试。"
  PACKAGE_URL="https://github.com/lhenlihai-hub/yaoguo/archive/${RELEASE_COMMIT}.tar.gz"
fi

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
npm install --global --prefix "$PREFIX" --omit=dev --no-audit --no-fund --loglevel=error \
  --fetch-retries=3 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=10000 \
  --fetch-timeout=60000 "$PACKAGE_URL"

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
const [file, installRoot, appPrefix, commandDir, releaseCommit] = process.argv.slice(1);
let release = null;
try {
  const metadata = JSON.parse(fs.readFileSync(`${appPrefix}/lib/node_modules/yaoguo/release.json`, "utf8"));
  release = {
    version: `${metadata.version || ""}`,
    build: `${metadata.build || ""}`,
    commit: `${releaseCommit || ""}`
  };
} catch {}
const manifest = {
  kind: "yaoguo.install",
  version: 1,
  installRoot,
  appPrefix,
  runtimeRoot: `${installRoot}/runtime`,
  artifactRoot: `${installRoot}/artifacts`,
  commandLinks: [`${commandDir}/yaoguo`, `${commandDir}/腰果`],
  ...(release ? { release } : {})
};
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
' "$INSTALL_ROOT/install.json" "$INSTALL_ROOT" "$PREFIX" "$COMMAND_DIR" "$RELEASE_COMMIT"

"$COMMAND_DIR/yaoguo" --version >/dev/null
say "腰果已安装。"
if [ "$PATH_READY" = true ]; then
  say "运行：腰果"
else
  say "新建终端后运行：腰果"
  say "若要在当前终端立即使用，请先执行：export PATH=\"$COMMAND_DIR:\$PATH\""
fi
say "卸载：腰果 uninstall"
say "更新：腰果 update"
