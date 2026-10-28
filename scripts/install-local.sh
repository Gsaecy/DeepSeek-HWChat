#!/usr/bin/env bash
# 本地安装 HWChat 扩展：自动挑最新的 hwchat-*.vsix，自动找 VS Code 命令行工具。
#
#   bash scripts/install-local.sh            # 安装最新包（同版本会用 --force 覆盖）
#   bash scripts/install-local.sh --check    # 只看会做什么，不安装
#   bash scripts/install-local.sh --list     # 列出已安装的 hwchat 版本
#
# 装完必须重载窗口（Developer: Reload Window）才会生效。

set -u

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE="install"

for arg in "$@"; do
  case "$arg" in
    -n|--check) MODE="check" ;;
    -l|--list)  MODE="list" ;;
    -h|--help)  MODE="help" ;;
    *) echo "未知参数：${arg}（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = "help" ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

# --- 1. 找 VS Code 命令行工具 -------------------------------------------------
find_cli() {
  # 1) PATH 里直接有 code
  if command -v code >/dev/null 2>&1; then
    command -v code
    return 0
  fi
  # 2) macOS 常见安装位置（稳定版、预览版、用户自装）
  for candidate in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/usr/local/bin/code" \
    "/opt/homebrew/bin/code"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# 允许外部指定（例如指向 Insiders，或测试时指向 /bin/echo）
CLI="${HWCHAT_CODE_CLI:-}"
if [ -z "$CLI" ]; then
  CLI=$(find_cli) || CLI=""
fi

if [ -z "$CLI" ]; then
  cat >&2 <<'EOF'
找不到 VS Code 命令行工具 `code`。

两种办法，任选一种后重新运行本脚本：

A. 让 VS Code 装好 `code` 命令（推荐，一次搞定）
   在 VS Code 里按 ⌘⇧P → 输入并执行：
     Shell Command: Install 'code' command in PATH

B. 不改 PATH，直接用界面安装
   1. 侧栏点扩展图标（⌘⇧X）
   2. 扩展视图右上角 `⋯` 更多操作 → Install from VSIX…
   3. 选中本仓库根目录的 hwchat-*.vsix
   4. 点右下角弹出的 Reload Window
EOF
  exit 1
fi

echo "命令行工具：$CLI"

# --- 2. 列出已装版本 ----------------------------------------------------------
list_installed() {
  "$CLI" --list-extensions --show-versions 2>/dev/null | grep -i '^honor-world\.hwchat' || true
}

if [ "$MODE" = "list" ]; then
  installed=$(list_installed)
  if [ -z "$installed" ]; then
    echo "尚未安装 hwchat。"
  else
    echo "已安装："
    printf '%s\n' "$installed"
  fi
  exit 0
fi

# --- 3. 挑最新的 vsix ---------------------------------------------------------
VSIX=""
for f in "$REPO_ROOT"/hwchat-*.vsix; do
  [ -e "$f" ] || continue
  if [ -z "$VSIX" ] || [ "$f" -nt "$VSIX" ]; then
    VSIX="$f"
  fi
done

if [ -z "$VSIX" ]; then
  echo "仓库根目录没有 hwchat-*.vsix，先打包：npm run package" >&2
  exit 1
fi

VSIX_BYTES=$(wc -c < "$VSIX" | tr -d ' ')
# BSD 与 GNU 的 `date -r` 语义不同，改用项目本来就依赖的 Node 取时间
VSIX_TIME=$(node -e 'process.stdout.write(new Date(require("fs").statSync(process.argv[1]).mtimeMs).toLocaleString("sv-SE").slice(0,16))' "$VSIX" 2>/dev/null || echo '未知时间')

echo "安装包：${VSIX}（${VSIX_BYTES} 字节，${VSIX_TIME} 构建）"

VSIX_VERSION=$(basename "$VSIX" .vsix | sed 's/^hwchat-//')
installed=$(list_installed)
if [ -n "$installed" ]; then
  echo "当前已装：$installed"
  case "$installed" in
    *"@${VSIX_VERSION}"*) echo "已装的就是 ${VSIX_VERSION}，下面用 --force 覆盖安装。" ;;
    *) echo "将把已装版本改为 ${VSIX_VERSION}。" ;;
  esac
else
  echo "当前未安装 hwchat，将全新安装 ${VSIX_VERSION}。"
fi

if [ "$MODE" = "check" ]; then
  echo
  echo "（--check 模式，未执行安装。真正安装请去掉 --check。）"
  exit 0
fi

# --- 4. 安装 -----------------------------------------------------------------
echo
echo "执行：\"$CLI\" --install-extension \"$VSIX\" --force"
if ! "$CLI" --install-extension "$VSIX" --force; then
  cat >&2 <<'EOF'

安装失败。常见原因：
  - VS Code 正在运行并占用扩展目录：重试一次通常就好。
  - 包坏了：重新 npm run package 生成 vsix。
  - 命令行工具指向别的 VS Code 版本（如 Insiders）：用 --list 确认装到了哪个实例。
EOF
  exit 1
fi

echo
echo "装后核对："
post=$(list_installed)
if [ -n "$post" ]; then
  printf '%s\n' "$post"
else
  echo "  ⚠ 已装列表里没看到 hwchat，请在扩展面板搜索 @installed hwchat 人工确认。"
fi

cat <<'EOF'

下一步（必须做，否则跑的还是旧代码）：
  按 ⌘⇧P → Developer: Reload Window

验证胶囊栏（把 HWChat 侧栏拖窄到胶囊放不下）：
  1) 完全没有滚动条
  2) 悬停在胶囊栏上滚滚轮 → 胶囊左右移动
  3) 按住往左拖 → 胶囊跟手移动，光标变“抓住”
  4) 拖完松手不应展开面板；随后正常点一颗胶囊，应照常展开
EOF
