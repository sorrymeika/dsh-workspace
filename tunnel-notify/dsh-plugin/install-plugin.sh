#!/usr/bin/env bash
# 把 @local/dsh-tunnel-notify 安装进 DSH 的 desktop profile
#
#   ./install-plugin.sh            安装（并把插件注册进 profile bundles）
#   ./install-plugin.sh uninstall  卸载
#   ./install-plugin.sh status     查看是否已注册
#
# 为什么需要写 ~/.dsh/profiles/<profile>/ ：
#   DSH 的 profile 目录在会话工作区之外，agent 的沙箱只能写工作区，
#   所以这一步必须在你的终端里跑（脚本本身不做任何特权操作）。

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
PKG_NAME="@local/dsh-tunnel-notify"

[[ -d "$PROFILE_DIR" ]] || { echo "❌ 找不到 profile 目录：$PROFILE_DIR（可用 DSH_PROFILE=xxx 指定）"; exit 1; }

sync_build() {
  ( cd "$PLUGIN_DIR" && node build.mjs >/dev/null )
}

case "${1:-install}" in
  install)
    sync_build
    echo "📦 插件目录：$PLUGIN_DIR"
    echo "🎯 目标 profile：$PROFILE_DIR"

    # 1) 作为依赖链接进去（link: 协议 = 符号链接，改代码即时生效；与
    #    dsh-prompt-manager 的安装方式一致）
    cd "$PROFILE_DIR"
    if command -v pnpm >/dev/null 2>&1; then
      pnpm add "link:$PLUGIN_DIR" 2>&1 | tail -5
    else
      npm install "file:$PLUGIN_DIR" --no-save 2>&1 | tail -5
    fi

    # 2) 注册进 profile bundles（幂等：已存在就跳过）
    node - "$PROFILE_DIR" "$PKG_NAME" <<'NODE'
const fs = require('fs');
const path = require('path');
const [profileDir, pkgName] = process.argv.slice(2);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (pkg.dsh.profile.bundles.includes(pkgName)) {
  console.log('ℹ️  bundles 中已注册，跳过');
} else {
  pkg.dsh.profile.bundles.push(pkgName);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('✅ 已加入 bundles:', pkgName);
}
NODE

    echo
    echo "🎉 安装完成。重启 DSH（退出并重新打开 DeepSeek Harness）后生效。"
    echo "   验证：重启后隧道地址一变，微信就会收到新链接。"
    echo "   日志：在 DSH 日志里搜 [tunnel-notify]"
    ;;

  uninstall)
    cd "$PROFILE_DIR"
    node - "$PROFILE_DIR" "$PKG_NAME" <<'NODE'
const fs = require('fs');
const path = require('path');
const [profileDir, pkgName] = process.argv.slice(2);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const list = pkg?.dsh?.profile?.bundles ?? [];
const next = list.filter((x) => x !== pkgName);
if (next.length !== list.length) {
  pkg.dsh.profile.bundles = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('🗑  已从 bundles 移除');
} else {
  console.log('ℹ️  bundles 中本来就没有');
}
NODE
    echo "🎉 卸载完成，重启 DSH 生效。"
    ;;

  status)
    node - "$PROFILE_DIR" "$PKG_NAME" <<'NODE'
const fs = require('fs');
const path = require('path');
const [profileDir, pkgName] = process.argv.slice(2);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const list = pkg?.dsh?.profile?.bundles ?? [];
console.log(list.includes(pkgName) ? '✅ 已注册：' + pkgName : '⚠️  未注册：' + pkgName);
console.log('   当前 bundles:', list.join(', '));
const linkPath = path.join(profileDir, 'node_modules', pkgName);
console.log(fs.existsSync(linkPath) ? '✅ 依赖已链接：' + linkPath : '⚠️  依赖未链接：' + linkPath);
NODE
    ;;

  *) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac