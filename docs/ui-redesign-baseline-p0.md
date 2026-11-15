# UI 重设计 P0 基线核验记录（docs/ui-redesign-plan-2026-11.md §7）

> 2026-11-15 · 分支 feat/ui-p0-baseline · 核验人：实施代理 · 本文件随 PR 链交付，后续批次如基线再变须回写

## 核验表（§7 要求逐项留证据）

| 核验项 | 开工时证据 | 结论 |
|---|---|---|
| r4/B4 合并状态 | 本分支 = `32cc887`（b0：B0+B1+B5+B7）× merge `origin/feat/r4-b3`=`d6c7303`（B1+B2+B3+B4 堆叠链）→ 合并提交 `827b4f8`。B4 即 PR #24（2026-11-15T04:46Z 由用户合入 b3）。Web 文件全自动合并，Android 4 文件冲突按双侧并集解决（细节见合并提交信息） | ✅ B4 已在基线；附带引入 B2/B3（feature flags 默认全关） |
| 备份真实接口 | `backup.js` 的 `BackupV3.build/read/commitImport/qualityTrim/lsTrim`；`app.js exportAll()`（app.js:1394，可选 sidecar 复选 `mSidecar`）与 `importAll(text)`（app.js:1432，parse→validate/preview→confirm→commitImport 三阶段 + 四件快照回滚，io 注入真实现）；服务端通道 `/api/store`、`/api/myradio`、`/api/quality {replace:true}`、`/api/listenstats {replace:true}`。契约 `contracts/backup-v3.schema.json` + fixtures（backup-v2/v3 黄金样本） | ✅ P5 按 `BackupV3.read` 的 preview 信息结构接 UI 预览，复用 commitImport，不另造事务 |
| 源生命周期 | `radio.cfg` v2 三字段清洗在 `app.js:166-168`（normCfg：srcManualOrder/srcDisabled=urlArrMap、srcLabels=normStrMap）；键=身份 URL `s.u[0]` 严格命中（applyCfg 注释 app.js:263-267）；`SrcOrder.effective` 挂 `s.mo/s.dis/s.moManual`；详情中心 `#detail`、`checkDetail` 结构化 code 已在 | ✅ P4 源草稿按此投影，不改 s.u[] |
| 契约基线 | `npm test` 12 文件 0 失败（含 contracts.js 13 键三侧比对 + fixtures 形态；smoke/diagnostic/quality/source-lifecycle/backup-v3/playlist-import/metadata/listen-stats/discovery/quality-store/sources/manifest 全绿）；`store.js KEYS` 与 `server.js STORE_KEYS` 同为 13 键 | ✅ 无漂移 |
| 新功能发布态 | `features.js`：metadataV2/listenStats/discovery 默认全 false，localStorage `feat.*` 覆盖；script 装载序 hls→store→player→logos→radio-data→features→srcorder→quality-store→metadata→listen-stats→playlist-import→backup→app→sync（index.html:408-419）。uiRefresh 开关将由 P2 加入 features.js（本期新增，默认 false） | ✅ 本轮 UI 不覆盖 B3 的 DOM/数据 |
| 播放阶段与平台边界 | Web `player.js` 无 REPLAYING/CATCHING_UP/SNAPSHOT_END/LIVE_AIR（B7 仅 Android Spike，docs/timeshift-spike-report.md 明确 Web 不做）；现有回调 onstate/onstatus/onlogo/onvol/onstepfav；Web 尚无 onphase——P3 按 §6.10 增加只读阶段通知 | ✅ 无回听分支需求 |
| 紧凑布局回归 | 既有取证 `docs/ui-redesign-assets/review-v22/layout-evidence.json`（390px 列表 337.47px、deadBtn 显示时 header 三行≈140px、theme 移入 lowfreq 后≈102px 两行）；390/768 全新浏览器复测在 P6 交付（§9.2 紧凑列表/header 组） | ⏳ P6 复测；P1 先按 §6.11 修复 |
| HTTP 与 file:// | `PORT=8199 node server.js`：`/`=200、`app.js`=200、`/data/store.json`=403（拒直读）、`POST /api/check`=405（方法守卫）。file:// 降级（radio-data.js 全库 + 直流可播）未在本次自动验证，P6 浏览器矩阵覆盖 | ✅（file:// 项 P6 补） |

## 判定记录（有争议处的临场决策）

1. **PR 底不是 main**：`main` 停在 PR #17（陈旧），r4 实际集成分支是 `feat/r4-b0`（#21/#22/#25 都合入于此）。全部 UI PR 采用堆叠链，P0 底=`feat/r4-b0`，后续每批底=上一批分支。
2. **基线并入 b3 整线而非摘 B4**：B4 提交与 B2/B3 同在 b3 堆叠链上，摘樱桃会造成双历史；b3 的 B2/B3 均为默认关的独立发布单元，符合 §7「保留已发布功能及开关」。B6（Android Auto）不在两线任一，不并入（Android-only，本轮不动 android 功能）。
3. **Android 冲突 get/set vs getStr/setStr 两对并存**：B2/B3 链把 String 版改名 getStr/setStr，B5/B7 调用点用 get/set。并集期两对并存语义一致，改名清扫留给后续批次（本轮不做无关重构）。gradle 因本机无 JDK 未跑，CI（android/** path filter）会触发验证。
4. **用户 WIP 文档随本 PR 入库**：规划文档 v2.2、历史草案、PR20-27 审计、ui-redesign-assets（截图/对比度脚本/handoff-helpers）、ui-demo、AGENTS.md 台标描述修正——即用户「暂存不要弄丢」的处置方式：入库保全 + 主工作区另行 stash 双保险。
