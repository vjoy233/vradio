# VRadio Android UI 升级——实施决策记录（随行链）

配套方案：[ui-android-redesign-plan-2026-11.md](ui-android-redesign-plan-2026-11.md)。本文件记录实施过程中「文档未穷尽 / 文档内部不一致 / 临场判断」的决策，每批 PR 随行更新；与方案正文冲突处以方案 §10 已确认硬门为准。

## 0. 分支与 PR 策略（开工前拍板）

- **基线 = `main`（cfe6080）**，不与测试链 PR #36–#43 混合（方案头部「适用分支」明确要求独立分支）。测试链合并后本链按需 rebase。
- **六连 PR 线性堆叠**：`feat/android-ui-plan`（本文档+方案入库）→ `feat/android-ui-p0`（导航与 token 基础）→ `feat/android-ui-p1`（电台库拆分+MiniPlayer+收藏页）→ `feat/android-ui-p2`（Full Player+详情层）→ `feat/android-ui-p3`（发现页+设置分组+DISCOVERY 翻 true）→ `feat/android-ui-p4`（大屏/可访问性/返回栈/验收收口）。
- **PR base 指向前一分支**（增量 diff 便于 review），合并顺序自底向上；每合一个，下一个 PR 的 base 改指 `main`。
- **§8.2 instrumented smoke 增量的归属**：`AndroidSmokeTest`/`PlaybackSmokeTest`/`BackupRestoreSmokeTest`/`TestUtil` 与 fixture 协议在测试链 PR #36/#40 中、尚未进 main。本链 P4 落盘 §8.2 新增用例文件，**依赖 #36/#40 先合并**才能跑 `connectedDebugAndroidTest`；P4 PR 说明中显式标注该先后依赖。本链自身硬门 = `./gradlew test` + `./gradlew assembleDebug`（不编译 androidTest 源集，不受影响）。
- 本机工作树：主目录 `D:\Vibing\vradio` 保持 `fix/store-empty-overwrite-wipe`（PR #43，勿动）；UI 链全部在 `D:\Vibing\vradio-wt-*` worktree 进行，`android/local.properties`/`env.local.sh` 按工作树单独补齐（gitignored）。

## 1. P0 批次决策

1. **旧 `Nav` 枚举删除时点**：方案 §7 P0 写「保留一个过渡批次」，但 §10 硬门与 §7 P1 明确「P0 同一 PR 内删除，不能跨批次存在」——**按 §10 执行**：P0 内 `Nav` 全量迁移为 `Destination`/`SecondaryRoute` 并删除，不留双状态过渡。
2. **收藏目的地 P0 起必须有真实内容**（导航项从 P0 就存在，空壳 tab 是发布半成品）：P0 在 `AppVm` 先落最小收藏投影 `favorites: StateFlow<List<Station>>`（按 `lib.favs` 顺序解析、只读不复制收藏状态），`FavoritesScreen` 以简列表呈现（点击播放/星标取消）；P1 按 §5.5 升级为 `FavoriteListUi` 全量（独立搜索/收藏内分类 chips/空态/ver 哨兵/Snackbar 撤销）并复用 `StationContent`。
3. **Mini player 过渡**：方案 §7 P0 给 VrScaffold 的要求是「mini player 占位」——P0 的 `VrScaffold` 底栏槽位沿用现有 `PlayerBar`（作为 `miniPlayer: @Composable () -> Unit` slot 由 AppRoot 注入），P1 换成 `MiniPlayer`。这样 P0 零行为回归、P1 替换点单一。
4. **`VrScaffold` 的 mini player 参数化**：§6.2 骨架把 `MiniPlayer(...)` 硬编码在 VrScaffold 内；实施改为 slot 参数（理由同上），布局骨架（Column 压栈、COMPACT 才挂 BottomNav、EXPANDED 挂 rail）与方案一致。
5. **`rememberVrWindow` 拆纯函数**：为满足 §8.1 `WindowClassTest`（599/600/839/840 断点）在纯 JVM 可测，拆出 `windowClassOf(screenWidthDp: Int): VrWindow` 纯函数，`rememberVrWindow()` 只做 `LocalConfiguration` 读取包装。
6. **返回栈纯函数**：§8.1 `NavigationStateTest` 要求「返回栈纯函数」——新增 `Navigation.backTarget(...)`（确认弹窗/sheet 属浮层态，由 root BackHandler 顺序消费；该纯函数只裁决「次级页返回 → 来源目的地」与「目的地守卫回退」），P4 接入系统返回链时复用。
7. **`destinationUi` 建模与接线分期**：§6.1 的按目的地保存（搜索/分类/滚动）在 P0 完成状态建模（`destinationUi: Map<Destination, DestinationUiState>` + `saveDestinationUi`），P1 搜索迁移 TopAppBar 时接线消费（§7 P1 搜索防抖随行迁移）。
8. **浮层挂载位置**：现有 AppRoot 把 sheets 挂在 Scaffold 之外的 Box 同级；P0 重排后保持「浮层由 root 统一挂载」原则（§6.4），仅把入口状态从 `Nav` 迁到 `SecondaryRoute`，不改各 sheet 内部。
