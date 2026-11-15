# UI 重设计 P6 验收记录（docs/ui-redesign-plan-2026-11.md §9 矩阵）

> 2026-11-15 · 基线 feat/ui-p5-data + P6 修复提交 · 驱动脚本 `ui-demo/p6-verify.cjs`（真实业务页面，自举隔离实例）
> 结果：**51 断言全过 / 10 张截图 / 0 页面脚本错误 / 全库 render 中位 60.4ms**（2026-11-15 合并日链尾收口，在七 PR 合并后集成链尾 727d806 重跑；此前 58.9ms 为合并前同脚本低负载实测、同期基线对照 134ms 属环境因素——脚本 3 轮空窗探测取最小中位，性能数字以链尾 p6/validation.json 为唯一来源）

## §9.1 自动与离线检查 → 测试文件映射（npm test 17 文件 0 失败）

| ID | 场景 | 覆盖 |
|---|---|---|
| F01–F06 | AND 搜索/组合筛选/最近队序/手动自动隐藏/scope 重置 | test/ui-scope.js（35 断言，vm 沙箱）+ P6 脚本 D 组真机复核（D5 界面=口径逐台比对） |
| M01–M04 | 草稿合并/冲突三选/撤销盲撤防护/保存失败留编辑 | test/ui-maintenance.js（33 断言） |
| B01 | B4 黄金样本与恢复事务/回滚 | test/backup-v3.js（B4 既有，未改动随跑全绿）+ test/ui-data.js（10 断言，uiCfgDiff/uiBackupPreview 消费 contracts/fixtures） |

## §9.2 浏览器矩阵（Chromium headless 实拍，分支工作区 http 形态）

| 组 | 断言 | 结果 |
|---|---|---|
| A 开关关零回归（1280+390） | 无 ui-refresh 类/侧栏隐藏/维护按钮原位/hero 双保险隐藏/390 列表满宽 390px/header 102px 两行/主题文字 span（lowfreq 内）/上一下一按钮/网格无横向溢出 | 10/10 |
| B 开关开桌面壳（1280） | 侧栏/维护入口接管/四列网格/`--ui-bg` token 实测生效/--dock-h>0/文档流滚动/hero 可见且候选非写死 | 8/8 |
| C 续听与播放态 | 点击才记最近/onphase 发布/停止后 idle（真实音频流未保证——沙箱网络，见「未验证项」） | 3/3 |
| D 组合筛选与空态 | 收藏范围 hero 隐藏/分类条完整/空态双出口/搜全部保词解范围/台名+分类 AND 界面=口径 | 5/5 |
| E 主题/tooltip/浮层 | 三选菜单三项/浅色生效+文案/聚焦全名 tooltip（fixed 以 hidden 判定）/Esc 收起/详情浮层全屏 fixed 遮罩（1280×800） | 5/5 |
| F 维护/数据 | 三分区 Tab/对象编辑器/dirty 离开三选/继续编辑草稿保留/取消丢弃/数据分区卡/cfg 导入差异预览/取消零改动/备份恢复覆盖预览行/恢复取消零副作用 | 10/10 |
| G 窄屏 390 | 侧栏 hero 隐藏/跨断点状态不丢/themeWrap 在 lowfreq/维护面板 390px 单列（fixed+flex column 实测）/焦点归还 | 5/5 |
| H 性能（真实全库 1521 台） | render() 中位 60.4ms < 100ms（链尾收口重跑 @ 727d806，空窗单轮即达标；历史低负载 58.9ms / 同期基线对照 134ms 属环境因素——脚本 3 轮空窗探测取最小中位） | 1/1 |

**视觉审查（visual-judge 独立代理，10 张逐审）**：8 pass；2 项处置——① 详情浮层源行「主源」徽标被 URL 截断行省略（**真实缺陷，已修**：徽标移出 `.dsrc-u` 截断行进可换行的 `.dsrc-i`，复拍确认完整）；② 窄屏维护截图误为深色（流程问题，已改浅色重拍）。

**P6 发现并修复的真实缺陷（3 处，均在本分支修复提交内）**：
1. **桌面 token 未生效**：P2 定义了 ui-* token 但 body/header/footer 仍用旧变量——修法 = 桌面作用域把旧语义变量别名到 ui-*（一处生效全组件，开关关零影响）。
2. **cfg 导入 Esc=执行导入（严重）**：`uiChooseDialog` resolve 值字符串，`importCfg` 用 `if (!ok)` 布尔判定，Esc 的 `'stay'` 是真值 → 取消也导入。修为 `ok !== 'ok'` 严格判定（同模式审计：resetCfg/撤回/importAll 三处本来就严格比较 ✓；P4 编辑器 depart 全部按值比较 ✓）。
3. **详情源行徽标截断**（视觉审查发现，见上）。

## 未验证项（如实记录，不做虚假通过宣称）

- **真实音频播放时序**：沙箱网络不保证国内流可达——onphase 只验证了 connecting/buffering/idle 链与停止归零；`playing` 36s 唱片旋转的真机出声验收留待实机（P3 agent 曾在真机直呼验证 playing→转，记录为参考证据）。
- **跨浏览器**：仅 Chromium（Playwright bundled）。Firefox/Edge/Safari 未跑，不宣称通过。
- **读屏（NVDA/VoiceOver）**：未跑真机读屏；aria 属性齐备性经代码层核对（aria-current/aria-pressed/role=alertdialog/aria-expanded），读屏抽查留待实机。
- **多标签对账冲突**：P4 agent 已实机验证（同台改名/冲突横幅/明确覆盖），本轮未重复双页面对抗测试。
- **200% 缩放/窄高窗口/forced-colors**：未逐项截验（CSS 无 fixed px 布局依赖侧栏 200px + minmax 网格，理论自适应；列入后续实机清单）。
- **390 deadBtn 显示态 header 行数**：基线死标记为空（全新工作区），deadBtn 隐藏态实测 102px；显示态场景需先造死标记数据，未造。
- **导出下载**：备份导出会触发浏览器下载，脚本未点击（避免下载弹窗），导出链路为 B4 既有代码未改动。

## 复现

```bash
npm start          # 仓库根（或 PORT=8237）
$env:VRADIO_PLAYWRIGHT='<本机 playwright 目录>'   # 开发工具非项目依赖
node ui-demo/p6-verify.cjs    # VRADIO_URL 默认 8137
# 产物：docs/ui-redesign-assets/p6/*.png + validation.json
```
