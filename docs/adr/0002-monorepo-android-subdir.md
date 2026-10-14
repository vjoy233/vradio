# 0002 安卓工程以 android/ 子目录留在本仓（monorepo）

VRadio 的 radio.txt 行格式、13 个 radio.* 持久键、vradio-backup.json 与 cfg 语义由 Web 侧工具链（update-sources.js / store.js / server.js）定义、安卓侧消费，且本项目当前阶段契约变更不低频（r2 批次即新增 volperst/srcmem2/baseline 系多键）。拍板：安卓工程以自包含的 `android/` 子目录留在本仓，契约变更一个 PR 原子更新两侧（2026-10-14 owner 问答轮拍板，D9）。

## 考虑过的选项

- **独立新仓库**：Web 仓纯净，但契约协调跨仓、AGENTS.md「⚠ 必须同步扩」警告块防御的「改了这头忘那头」类 bug 被仓库边界结构性放大。
- **独立仓 + git submodule 引数据文件**：Windows/AI 工作流体验差。

## 后果

拆分是单向易门（`git filter-repo --subdirectory-filter android/` 可带完整历史拆出），合并不可逆，故先 monorepo 保留拆分期权；重评估触发条件（安卓成主产品/换维护者/F-Droid 可复现构建对仓内二进制产生实际摩擦/Web 侧明确纯净诉求）见 docs/plan-android.md 5.1。
