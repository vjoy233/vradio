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

## 4. P4 实施落账

1. **内容最大宽度拍板值 = 720dp**（§7 P4「平板 rail 与内容最大宽度实测」）：EXPANDED 档 LIBRARY/FAVORITES 列表内容限宽居中；发现页横滚行保持全宽；COMPACT 无感。owner review 可调。
2. **TalkBack 语义契约**（串与 §8.2.9 断言对齐）：播放钮按态「播放/暂停/连接中」、中列「正在播放：<台名>，点按展开播放器」、搜索/更多、收藏星「收藏/已收藏」、⏮⏭「上一/下一收藏台」、音量 stateDescription「音量 N%」、设置组头「设置分组：<title>」+「已展开/已折叠」、发现卡「<台名>，点按播放」。Navigation.kt 反编译核实 M3 NavigationBarItem 自带 selectable+Role.Tab 合并语义——图标不加双读。
3. **合并语义实证**：foundation clickable/combinedClickable merge descendants=true、ContentDescription 追加策略——卡内 FavStar 被父节点吞并，其 cd 追加进卡片合并串（hasContentDescription any 匹配两树皆命中）。
4. **androidTest 增量（§8.2）**：新 `UiRedesignSmokeTest.kt`（7 用例：设置往返保留/fixture 播放跨目的地不断流/full player 动作/双形态分档几何/收藏搜索与撤销/目的地状态保留/语义契约）+ 测试依赖登记（compose ui-test 两件套 + BOM 对齐，**零运行时依赖**）。**依赖链挂账**：引用测试链 #36/#40 的 TestUtil.dataGuard/assumeFixture 基建——本链分支不编译 androidTest 源集；**交叉编译验证已做**：「feat/android-ui-p4 × origin/test/p2-browser-android」临时合并 worktree 跑 `assembleDebugAndroidTest` BUILD SUCCESSFUL（期间修复 3 处：成员函数误 import、本地 hasRole 拼装、EditableText 是 AnnotatedString 取 .text——均为测试文件修复，主源集零改动）。临时合并仅本地验证、不推送不进链；build.gradle.kts 双链冲突已在验证树手工并案（两侧 androidTest 依赖共存），正式合入时按同款处理。
5. **返回链（§7 P4）**：确认弹窗/各 ModalBottomSheet 窗口自收（P2 已接）→ Full player → 次级页（backTarget）→ 系统默认；未覆盖系统 predictive back 动画（未改 manifest BackHandler 配置）。
6. **手测/设备项挂账**（无 adb/模拟器，owner 侧执行）：320×720/360×800/390×844/800×360 设备矩阵、dark/light/OLED、字体放大、TalkBack 真机、强制深色、离线、空态/错误态走查；`connectedDebugAndroidTest`（fixture 旋转/后台播放硬门）待 #36/#40 合并后跑（§8.2.5 无网络态需 NetGate 注入面，挂账 §10 附录口径）。
7. **P4 验证证据**：`test assembleDebug` BUILD SUCCESSFUL（主源集全绿）；交叉编译 `assembleDebugAndroidTest` BUILD SUCCESSFUL。

## 5. AIbot review 响应落账（#44–#49 第一轮，全部沿链 merge forward）

### 采纳并已修（按 PR）
- **#45-P1 次级页覆盖 mini player**：Settings/AddStation 从全屏覆盖层改进 VrScaffold **同一 content 槽**（mini player/底栏/rail 全局常驻 §3.2/Q20）+ 两页消费 pad（#49-P1 同修）。§6.4 骨架的覆盖层伪代码按此修订。
- **#45-P1 DISCOVERY 旧入口残留**：P3 已全删+grep 清零；门升级为可复现脚本（见下）。
- **#45-P2 secondaryFrom 死状态**：取中间路径——次级页期间显式切目的地（vm.navigate）**自动收次级页**，返回始终回当前目的地，Q11 在全路径成立；secondaryFrom 保留为记录性字段。
- **#45-P2 destinationUi 未接线**：P1 已接线（快照/恢复+护栏），无需新动作。
- **#46-P1 收藏撤销差分桥误报**：**整段删除**；StationContent 增 `onFavToggle` 注入，收藏页传 `vm::unfavWithUndo`——撤销事件由 AppVm 单一产生（Q13/Q17 语义收紧）。
- **#46-P2 Composable 直写 VM 流**：AppVm 增 `clearFavUndo()` 单一消费；UI 层 `favUndoReq.value=` 写归零（grep 证）。
- **#46-P2 卡/行缺详情入口**：补 48dp「ⓘ」DetailBtn（§5.1），cd「电台详情」。
- **#46/#47-P1 status 三处 6s 自清竞态**：收敛 AppVm `setStatus`（每次写入重启 TTL 单一所有者）；MiniPlayer/PlayerBar/PlayerSheet 自清全删，UI 只读。
- **#47-P1 PlayerSheet 关闭无收口**：onDismissRequest 改 `hide()` 完成后再 closePlayer（滑下动画保留）；「sheet 状态一次打开生命周期内有效」显式声明（review 的第二候选口径）。
- **#47-P2 单源台错误态显「换源」**：门控 `u.size > 1` 才渲染。
- **#48-P2 折叠态 rememberSaveable 违反 Q18**：改 plain `remember`（进程死亡回默认；旋转丢折叠态为拍板取舍，注释注明）。
- **#48-P2 chips 行 320dp/字体放大溢出**：4 处 FilterChip 容器改 **FlowRow** 换行。
- **#48-P2 双态证据不可复现**：新增 `android/tools/dual-state-check.sh`（翻 false 构建→还原构建→残留核对）+ 本轮新鲜证据（两态 BUILD SUCCESSFUL）。
- **#49-P1 mini player 横跨全宽覆盖 rail**：VrScaffold EXPANDED 档重构——mini player 移内容列底部（§3.3「播放条横跨内容区底部不覆盖 rail」，修订 §1.4 的骨架口径拍板）；UiRedesignSmokeTest 补几何断言（playBtn 左缘 ≥ rail 右缘 / COMPACT 在导航之上）。
- **#49-P2 父卡/行 Role.Button 嵌套**：父节点去 role（保留 cd「点按播放，长按收藏」），FavStar 保持独立 Button；测试星标点击改 **useUnmergedTree=true**（merged 树点击会命中父行=播放）。
- **#45-验收点**：设置页期间 mini player 常驻断言进 §8.2.1 用例。

### 不采纳（理由）
- **#46-P2 收藏页与电台页共享 view（网格互串）**：方案 §5.5 明文「列表/网格**复用 radio.view**」——共享即规格；不拆分页视图状态。
- **#49-P1 改用 createAndroidComposeRule**：与「singleTask 每用例重启拿干净 AppVm 态」的隔离口径冲突；`createEmptyComposeRule + ActivityScenario.launch` 绑定同一 Activity Compose root，等价——绑定口径已写进测试类 KDoc。真跑 connected 的合并门不变（#36/#40 + 设备）。

### 挂账不变（设备/链依赖）
connectedDebugAndroidTest、320/390/800dp 真机矩阵、200% 字体、TalkBack 真机、离线态（NetGate 注入面）、testTag 化（#49-P3：真实数据下可见文本定位可能误命中，已 KDoc 注明风险）。

### 基础设施
- #49 CI 失败 = **Aliyun maven 镜像 502（瞬态）**，rerun 通过；非代码问题。
- 修复波全程沿链 merge forward（p0→p1→p2→p3→p4），冲突按修正终态裁决（PlayerBar 取 P2 重构版、StationContent 取注入版、AppRoot 取并集）；androidTest 交叉编译二次验证 BUILD SUCCESSFUL。

## 6. AIbot review 二轮响应落账（增量复核保留项）

1. **#45-P2 secondaryFrom 死状态**：取「删除+文档统一」——次级页期间目的地不可变（navigate 自动收口），返回=当前未改变的目的地；AppVm 字段/写入删除，Navigation.kt/AppRoot KDoc 口径统一（grep 归零）。
2. **#46-P2 favUndoReq 单槽覆盖**：取「事件队列」——`FavUndoEvent(id, station)` Channel 逐操作入队，AppRoot 顺序消费（一条 Snackbar 关闭再出下一条，互不覆盖），`clearFavUndo()`=排空在飞队列（Q17 离开收藏页作废）；撤销按 URL 身份不变。新增 instrumented `快速连续取消收藏逐条可撤销`（两次连续取消→两条 Snackbar 顺序出现→各自撤销恢复）。
3. **#47-P2 子 sheet 返回链 instrumented 覆盖**：UiRedesignSmokeTest 新增 `子sheet返回链`（Full Player→选源→返回→歌史→返回→返回关层，裁决=ModalBottomSheet 独立窗口自消费返回先序于 root BackHandler）+ `旋转后播放不断流且返回关层`（scenario.recreate：ViewModel 存活/播放不断流 Q20/sheet 态一次打开生命周期）；fixture Assume 门控（未接 fixture 自动 skip，ciRequired=1 fail）。**执行仍需设备/模拟器（本机无 emulator）——#40 已合并，#49 合并后 connectedDebugAndroidTest 即可在设备上跑**。
4. **#49-P2 dual-state 脚本护栏**：脏工作树拒绝执行 + trap 兜底还原 + 收尾**整树**核验（不只单文件）；本轮新鲜证据：关闭态/开启态两态 BUILD SUCCESSFUL + 整树无残留。
5. **#48 二轮说明**（信息性）：部分修复来自沿链阶梯提交、不在原 PR 差集——成立；#48 合并时因 p2⊇p3 阶梯事故携带了 P0–P3 全树进 main（已在 #49 链态评论披露），后续批次差集以 #49 为准。
6. **设备侧硬门挂账不变**：connected smoke、320/390/800×360、200% 字体、TalkBack 真机、离线/错误态——本机无 emulator（platform-tools 有 adb、无设备/镜像），owner 侧执行；交叉编译验证改为直接 × 已合并测试链的 main（assembleDebugAndroidTest + test BUILD SUCCESSFUL），不再需要临时跨链合并。
7. **testTag 化**（#49 二轮重申）：继续挂账——真实设备跑通首轮后按误命中情况逐步替换可见文本定位。
