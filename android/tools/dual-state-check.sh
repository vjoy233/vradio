#!/usr/bin/env bash
# DISCOVERY 发布闸双态编译期验收（docs/ui-android-redesign-decisions-2026-11.md §3.1/§5/§6）
# 用法：cd android && source env.local.sh && ./tools/dual-state-check.sh
# review#49 二轮 P2 护栏：①脏工作树拒绝执行（脚本会临时改 FeatureFlags.kt）；
# ②trap 兜底还原（中途失败也还原）；③收尾核验整棵工作树无残留（不只单文件）。
set -e
FF=app/src/main/java/io/github/vjoy233/vradio/FeatureFlags.kt
[ -z "$(git status --porcelain)" ] || { echo "工作树不干净，拒绝执行：先提交/暂存后再跑"; exit 2; }
restore() { git checkout -- "$FF" 2>/dev/null || true; }
trap restore EXIT
grep -q "const val DISCOVERY = true" "$FF" || { echo "提交态必须是 DISCOVERY=true"; exit 2; }
echo "=== 关闭态（临时翻 false）==="
sed -i 's/const val DISCOVERY = true/const val DISCOVERY = false/' "$FF"
./gradlew.bat test assembleDebug || { echo "关闭态构建失败"; exit 1; }
echo "=== 开启态（还原 true）==="
git checkout -- "$FF"
./gradlew.bat test assembleDebug || { echo "开启态构建失败"; exit 1; }
grep -q "const val DISCOVERY = true" "$FF" || { echo "还原失败"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作树有残留（整树核验失败）"; exit 1; }
trap - EXIT
echo "=== 双态验收通过，整树无残留 ==="
