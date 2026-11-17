#!/usr/bin/env bash
# DISCOVERY 发布闸双态编译期验收（review#48 P2：证据可复现）——docs/ui-android-redesign-decisions-2026-11.md §3.1/§5
# 用法：cd android && source env.local.sh && ./tools/dual-state-check.sh
# 流程：记录提交态 → 翻 false 构建+测试 → 翻回 true 构建+测试 → 核对工作树无残留 → 任一失败非零退出
set -e
FF=app/src/main/java/io/github/vjoy233/vradio/FeatureFlags.kt
grep -q "const val DISCOVERY = true" "$FF" || { echo "提交态必须是 DISCOVERY=true"; exit 2; }
echo "=== 关闭态（临时翻 false）==="
sed -i 's/const val DISCOVERY = true/const val DISCOVERY = false/' "$FF"
./gradlew.bat test assembleDebug || { git checkout -- "$FF"; exit 1; }
echo "=== 开启态（还原 true）==="
git checkout -- "$FF"
./gradlew.bat test assembleDebug || exit 1
grep -q "const val DISCOVERY = true" "$FF" || { echo "还原失败"; exit 1; }
git diff --quiet "$FF" || { echo "工作树有残留"; exit 1; }
echo "=== 双态验收通过，工作树无残留 ==="
