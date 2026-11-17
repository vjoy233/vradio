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

## 1.x P0 实施落账（合并后补记）

1. **收藏顺序**：方案 §5.5/Q16 写「最新收藏置顶」，但现有实现（Web/Android 两侧 favs 均追加式、新收藏在尾）按写入序遍历——P0 投影沿用现有写入序不发明反转；P1 全量版（FavoriteListUi）裁决：若按方案置顶则展示层反转、数据层不动。
2. **`locatePlaying()`（回到正在播）迁移语义**：旧 `nav=LIST` → `destination=LIBRARY + closeSecondary()`（从次级页也能一键回电台）。
3. **`VrScaffold` 无 `player` 参数**：mini player 以 slot 注入后状态源由 slot 自带（§6.2 骨架的 player 参数随之取消）。
4. **DISCOVER 分支**：P0 为编译穷举空壳（`FeatureFlags.DISCOVERY=false` 关闭态 + `navigateGuard` 双保险不可达），P3 填 `DiscoveryScreen`。
5. **P0 验证证据**：`./gradlew.bat test assembleDebug` BUILD SUCCESSFUL；新增 NavigationStateTest（13 断言）+ WindowClassTest（6 断言）全绿；旧 `Nav` 枚举零残留（grep 证）。

## 1.y P1 实施落账

1. **`buildFavoriteListUi` 增第 5 参 `cats`（默认空表）**：纯函数不能调 lib，chips 顺序需按 `lib.cats()` 过滤——combine 里传入；默认空时按收藏数据序兜底（4 参形式照常成立）。
2. **Q16「最新收藏置顶」**在纯函数内 `asReversed()` 实现（入参=favorites 投影写入序）；数据层不动。
3. **`StationContent` 复用签名增补 `inCat` 投影参数**：旧实现读电台页 `vm.cat` 判分类徽标冗余，收藏页不能读它——改投影参数。
4. **撤销 Snackbar**：M3 无 8s 档，取 `SnackbarDuration.Long`（10s）≈「约 8 秒」口径；离开收藏页 dismiss + 清载荷（Q17）。
5. **⚠ 技术债：星标撤销桥接**——StationContent 行内星标硬编码 `vm.toggleFav` 且本批冻结该文件，FavoritesScreen 以「单台丢失且仍在库」事件判别补发撤销请求（三重防误报：首帧建基线不比对/仅单台丢失/仍在库判别）。后续批次（P2/P4）机会式改为 StationContent 注入 `onFavToggle` 回调后删除桥接。
6. **MiniPlayer `navigationBarsPadding()` 仅 EXPANDED 档**：平板/横屏 mini player 即屏幕底缘，三键导航会遮播放钮；COMPACT 档下方 NavigationBar 自理 inset。
7. **滚动恢复护栏**：恢复 key 用「列表非空」（boot 未就绪时 scrollToItem 会被 clamp 到 0）+ `restored` 一次性标志（防空→非空翻转拽回旧位）。
8. **设备矩阵手测（320×720/360×800/390×844/800×360）**：本机无 adb/模拟器，留 owner 手测门（§7 P1 实测项），不作为合并阻塞（JVM 门全绿）。

## 2. P2 实施落账

1. **`playerVisual` 位置**：`PlayerSheet.kt` 顶层纯函数（同包 JVM 直测）；不扩展 PState（P1-1 修订硬门），MiniPlayer 行内映射暂不动（后续批次收敛到 playerVisual）。
2. **「回到电台页」= `vm.locatePlaying()` + `vm.closePlayer()`**：sheet 全屏遮挡时不收起看不到定位高亮——保留浏览上下文语义，仅补收起。
3. **PlayerBar.kt = 纯控制件复用层**：旧 bar 容器删除（MiniPlayer 已取代），导出 PlayPauseBtn/SleepControl/VolumeControl/ActText 供 PlayerSheet 引用（sleepMenu/dragVol 收编单份不再复制）；`vm.status` 反馈行补进 full player（stepFav 无收藏提示等反馈需显示位，6s 自清与 MiniPlayer 幂等双写，后续收敛）。
4. **Full player 主按钮 72dp**、⏮⏭ 自绘 SkipIcon（Canvas，无图标库）；sheet 内容 Column 加 verticalScroll 保障 PartiallyExpanded 拖拽手感（Q10）。
5. **BackHandler 层级（Q21）**：确认弹窗/ModalBottomSheet 自收（窗口自消费）→ root 先 Full player 后次级页；`backTarget` 纯函数语义不变。
6. **SourceDetailSheet**：头部无 sticky（sheet 首屏自然可见，已注明）；主操作位=播放/重播，管理动作收「更多」DropdownMenu（`sourceRowActs` 纯函数与枚举零改动，JVM 测试不涉）；诊断中=spinner+不可点（无取消通道，§5.7 口径）。
7. **SongsSheet**：补歌史时间列展示层格式化（当天 HH:mm/跨天 MM-dd HH:mm，Locale.US 同既有先例；SongRec.at 存储不动）。
8. **P2 验证证据**：`test assembleDebug` BUILD SUCCESSFUL；PlayerUiMappingTest 8 用例全绿（noSrc 优先/CONNECTING±status/PLAYING/PAUSED/IDLE±status 三元组断言）。

## 3. P3 实施落账

1. **发布决策门验收（编译期双构建证据）**：开启态（`DISCOVERY=true`，提交态）`test assembleDebug` BUILD SUCCESSFUL；关闭态（临时翻 false，**构建后即还原**，不入库）同样 BUILD SUCCESSFUL——`NavigationStateTest` 改 JUnit4 `Assume` 双态假设（开启态跑 A 块三目的地断言、关闭态跑 B 块两项断言、公共断言恒跑），两种编译态测试套件全绿。混合态（新导航+旧浮层）已消除：DiscoverySheet.kt 删除、showDiscovery 流删除、✦ 入口删除（grep 零代码级残余）。
2. **「最近新增」未绑定说明**：Groups 无现成字段、旧 sheet 无对应文案——屏幕直接读 AppVm 既有只读 `metaBound`（纯展示消费，派生零改动）；metaBound 变更点随 stamp bump 触发 discovery 流重发，无陈旧窗口。
3. **DiscoveryRow 不保留**：旧 Row 形态在新屏无引用，提取为顶层 `DiscoveryCard`（logo 由 vm.logoOf 注入，不持 vm）——不留死代码。
4. **设置页「显示无效源」并入外观组**（plan 七组无此项，不丢设置）；「维护配置」解读为 radio.cfg 导入/导出两行（从导入导出组移入电台组）；「导出收藏 m3u」保留在备份与导入组（plan 字面只列歌单导入，不丢设置）。
5. **设置页签名保持 `SettingsScreen(vm)`**：§6.2 的 SettingsScreen(vm, pad) 按旧草案；§10 已确认决策「设置是次级页面」= 覆盖层形态，不进 VrScaffold 内容区（无 Scaffold pad 可传），自理状态栏/导航栏 padding。
6. **折叠状态** = rememberSaveable（stringSetSaver）进程内（Q18：旋转重建保留、进程死亡回默认）；新增 `defaultExpandedIds()` 纯函数供屏幕与测试共用默认展开口径。
7. **P3 验证证据**：开启态/关闭态双构建 + SettingsSectionTest 5 用例 + NavigationStateTest 8 用例（2 skipped 属双态假设设计）全绿。
