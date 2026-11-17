# VRadio Android UI 体验升级方案

版本：v0.1 调研方案
日期：2026-11-17
状态：Grill 完成，待 owner 最终 review
适用分支：Android UI 独立分支；不与 PR #36–#43 的测试链混合

## Review 审议记录

### Grill round 1

- Q1 首要设备目标：**手机竖屏优先，平板/横屏保持可用**。首轮体验和验收以 320–390dp 手机为主；平板/横屏先保证导航 rail、内容不遮挡、播放连续，大屏双 pane 不列为首轮硬门。
- Q2 顶层导航：**电台 / 发现 / 收藏**；设置降为次级入口，可收进“更多/设置”。收藏页必须复用 `lib.favs` 与 URL 身份语义，不能复制收藏状态。
- Q3 播放器层级：**全局 Mini Player + 点击展开 Full Player**。
- Q4 Full Player 容器：**ModalBottomSheet / BottomSheetScaffold**。
- Q5 默认列表视图：**列表视图**；网格继续作为用户可选视图，`radio.view` 语义不变。
- Q6 设置入口：**右上角更多菜单进入设置**；设置不占顶层导航位置。
- Q7 自适应导航实现：**P0–P2 使用 `screenWidthDp` + 现有 Material3 手写 Bottom Nav/Rail；P4 再评估 `material3-adaptive-navigation-suite`**。原因是当前只有三个目的地、手机竖屏优先，手写方案不引入依赖且行为更可控；adaptive suite 保留给折叠屏、动态窗口或双 pane 需求出现后的决策门。
- Q8 收藏页形态：**独立收藏页，复用列表组件但只展示收藏**；收藏页不复制收藏状态，继续读取 `lib.favs`/`favKeys`。
- Q9 Mini Player 操作密度：**只保留台名、曲讯、播放/暂停；点击展开 Full Player**。
- Q10 Full Player 高度：**半屏起步，可拖到全屏**；播放连续性不受拖拽影响。
- Q11 设置返回层级：**设置作为次级页面，系统返回回到进入它的原顶层目的地**；进入设置时记录来源目的地。
- Q12 收藏页筛选：**收藏页独立搜索，分类 chip 只显示收藏内分类**。
- Q13 取消收藏：**立即从收藏页移除，并提供可撤销 Snackbar**；撤销只恢复本次 URL 收藏状态。
- Q14 发现开关关闭：**隐藏发现导航项，电台与收藏保持两项导航**，不保留空位。
- Q15 导航状态保存：**各顶层目的地保留自己的搜索/滚动状态；设置返回进入设置前的原目的地**。
- Q16 收藏排序：**沿用现有收藏顺序，最新收藏置顶**。
- Q17 取消收藏撤销：**Snackbar 约 8 秒可撤销；离开页面后撤销失效**。
- Q18 页面状态保存：**搜索/分类/滚动只在进程内保存；进程被杀后恢复默认**，不新增 `radio.*` 键。
- Q19 添加电台层级：**设置次级页 + 电台页更多菜单直达**。
- Q20 播放连续性硬门：**切换电台/发现/收藏/设置、旋转、打开/关闭 Full Player 都不能中断播放**。
- Q21 返回优先级：**确认弹窗 → Full Player/详情 sheet → 设置/添加页 → 原顶层页**。
- Q22 错误恢复：**错误必须同时给出原因和可执行动作**，动作至少覆盖重试、换源、打开详情或返回列表中的适用项。
- Q23 实施节奏：**P0–P4 连续完成，不在 P0–P2 设置停点**；每批仍需通过对应验证。
- Q24 测试硬门：**JVM + Android fixture smoke + 320/390dp 手测 + 旋转/后台播放**。
- Q25 平板详情布局：**首轮保留 sheet；P4 只保证 rail 与内容不遮挡，不实现列表/详情双 pane**。
- Q26 设置默认展开：**默认展开“播放”和“数据与体检”，其余分组折叠**。

### 外部 Review 修订结论（2026-11-17）

- **采纳 P1-1**：播放器状态不扩展 `PState`。Full Player 与测试统一使用 `PState × noSrc × status` 组合映射；错误仍是 `IDLE + status`，全禁仍是 `noSrc=true`。
- **采纳 P1-2**：Discovery 发布闭环为“P0–P2 保持 `FeatureFlags.DISCOVERY=false`；P3 `DiscoveryScreen`、导航和测试同一批完成后翻为 `true`”。不允许出厂出现“新导航 + 旧浮层”混合态。
- **采纳全部 P2/P3 细节**：补齐 padding 传递、收藏投影归属、时移入口、滚动快照时机、收藏范围去重、sheet 状态唯一所有者、防抖迁移、真实文件位置和 P0 删除旧 `Nav` 的时点。
- **采纳收藏入口去重建议**：电台页不再显示 `★收藏` 范围 chip，只保留“全部 / 最近”；收藏顶层页是收藏集合的唯一主入口，避免两套搜索/分类状态造成认知分裂。旧 `cat=★收藏` 读取可兼容，但新 UI 不再写入该哨兵。

### Discovery 发布决策门

Android 当前 `FeatureFlags.DISCOVERY` 是编译期 `const val false`，Web 侧已翻为 true。Android 本轮不在 P0–P2 提前翻转；P3 必须在同一批完成 `DiscoveryScreen`、顶层导航、测试矩阵和旧 `DiscoverySheet` 入口迁移后，再将 Android flag 翻为 true。P3 之前的构建只验证关闭态；P3 之后至少保留一次关闭态构建和一次开启态构建作为编译期验收证据。

## 1. 目标与结论

本轮目标是把 Android 端从“功能齐全的 Compose 页面集合”升级为“以持续收听为中心的移动产品”：用户进入应用后能快速找到台、立即播放、看清连接/曲讯状态，并在切换列表、发现、设置和系统后台时保持播放上下文。

方案结论：

1. 采用“电台库 / 发现 / 收藏”三项顶层导航。设置作为次级页面，从右上角更多菜单进入并记录来源目的地。手机使用底部导航；平板、折叠屏展开态和横屏大宽度使用导航 rail。
2. 播放器成为全局连续上下文：底部 mini player 常驻，点击展开 full player；源选择、歌曲历史、睡眠、刷新、分享和详情都从 full player 或详情 sheet 进入。
3. Web 端已验证的 token、台标回退、播放状态、范围筛选、源诊断和维护事务语义继续复用；桌面侧栏、hover、键盘快捷键和大幅 hero 不直接搬到手机。
4. 第一批不新增运行时依赖，不改 `radio.*`、`radio.cfg`、备份 v3、`Station`、`PlayerUiState` 或播放器决策链。自绘 `VrNavigationScaffold` 和现有 Material3 组件足以完成首轮升级。
5. 第二批再评估是否引入 `androidx.compose.material3:material3-adaptive-navigation-suite`。如果引入，必须单独登记依赖白名单、版本、APK 体积和 CI 影响。

产品主线：

```text
打开应用 → 看见上次/当前收听上下文 → 搜索或按范围找台 → 一次点击播放
                                  ↓
                  发现稳定台 / 有曲讯台 / 最近新增
                                  ↓
                 设置、同步、体检、备份等低频任务
```

## 2. 调研依据

### 2.1 项目现状

当前 Android 已具备以下真实能力：

- `AppRoot` 以单 Activity + Compose 组织现有 `Nav.LIST / Nav.SETTINGS / Nav.ADD` 三个手写导航态（`Nav` 实际定义在 `ui/AppVm.kt`），底部 `PlayerBar` 常驻。
- `AppVm` 已集中维护列表筛选、收藏、最近、主题、死台开关、发现、诊断、网络策略、备份导入导出和同步状态。
- `StationList` 已具备网格/列表双视图、搜索防抖、分类 chip、收藏、长按收藏、死台徽标、连接中指示和回到正在播。
- `SrcSheet` / `SourceDetailSheet` 已具备选源、逐源诊断、源启停、源排序、复制、恢复默认和歌史入口。
- `PlayerBar` 已具备播放/暂停、连接中 spinner、曲讯、码率、睡眠、选源、刷新、时移、分享和音量。
- `SettingsScreen` 已覆盖主题、续播、音频卸载、死台、体检、同步、网络策略、添加台、备份恢复、歌单导入、歌史导出和反馈。
- `DiscoverySheet` 已具备质量/健康/元数据派生分组。

现状主要问题不是能力缺失，而是层级和入口分散：列表头部同时承担品牌、搜索、设置、视图、死台、发现、分类；`PlayerBar` 是高密度操作带，无法承载 full player 的沉浸层；设置页过长，低频工具和高频播放设置混在一起；导航态只有手写枚举，平板/横屏没有布局变体。

### 2.2 外部平台方向

- Android 官方 adaptive navigation 指南建议：紧凑窗口使用底部导航，展开窗口使用 navigation rail；顶层目的地保持 3–5 个并在不同窗口宽度切换布局。
- Material 3 的 rail 适合中等、展开、大屏窗口，通常承载 3–7 个目的地；当前产品只需要三个顶层目的地。
- Media3 的 Compose UI 可以只使用状态 holder，也可以使用预制 `MiniController` / `Player`。本项目已有自定义播放器状态和 Web 同语义要求，因此首轮保留自绘控制层，避免引入无法完全复用的预制视觉结构。
- Android 系统媒体控制会从 `Player`/`MediaSession` 状态生成播放、暂停、上一台、下一台等系统控制；UI 改版必须继续以 `PlayerHolder.ui` 和现有 `PlaybackService` 为唯一播放状态源。
- 移动端交互采用至少 48dp 命中区、可见状态反馈、稳定返回栈、单一主滚动容器和 Lazy 列表稳定 key。现有列表已经使用 LazyColumn/LazyVerticalGrid 与稳定 key，应保留。

官方资料：Android Developers《Build adaptive navigation》、Material 3 Navigation Rail、Android Developers《Media controls》与《Compose-based UI for Media3》。

### 2.3 不直接照搬 Web 的内容

| Web 形态 | Android 处理 |
|---|---|
| 桌面侧栏 | 手机底部导航；平板/横屏 rail |
| 大幅续听 hero | mini player + full player，首屏留给找台 |
| footer 多按钮 | mini player 只保留播放/暂停和上下文；更多动作进入 full player |
| hover tooltip | 长按/辅助说明/可展开详情 |
| 键盘快捷键 | 系统返回、媒体键、通知栏、耳机线控、Widget |
| 多列维护面板 | 设置中的分组页面 + 独立编辑 sheet |
| Web 详情浮层 | Android ModalBottomSheet，支持系统返回和下滑关闭 |

## 3. 信息架构

### 3.1 顶层目的地

```kotlin
enum class Destination(val title: String) {
  LIBRARY("电台"),
  DISCOVER("发现"),
  FAVORITES("收藏"),
}
```

`SETTINGS` 与 `ADD_STATION` 不作为顶层目的地。设置从各顶层页右上角更多菜单进入，添加电台从电台页更多菜单或设置页进入；进入设置时记录来源目的地。详情、选源、歌史、full player 都是子层，不写入顶层导航。

### 3.2 手机布局（宽度 < 600dp）

```text
┌──────────────────────────────┐
│ TopAppBar：标题 / 搜索 / 更多 │
├──────────────────────────────┤
│ 范围 chip：全部 / 最近         │
│ 分类 chip 横向滚动            │
│                              │
│ 电台网格或列表                │
│                              │
├──────────────────────────────┤
│ MiniPlayer：台名 / 曲讯 / ▶   │
├──────────────────────────────┤
│ 电台       发现       收藏     │
└──────────────────────────────┘
```

规则：

- 电台页首屏优先展示搜索、范围和电台，不放大幅欢迎区。
- mini player 固定在 bottom navigation 上方，内容区使用实际高度补偿，不能覆盖最后一行。
- 发现页是独立页面；当 `FeatureFlags.DISCOVERY` 关闭时，隐藏目的地并将默认目的地回退为电台。
- 当 `FeatureFlags.DISCOVERY` 关闭时，底部导航/rail 只显示“电台”和“收藏”，不显示发现空位。
- 设置页的返回由系统 back 和 TopAppBar navigation icon 共同完成，返回进入设置前的原顶层目的地，不通过重新创建 Activity。
- 收藏页是独立目的地，但复用电台列表/卡片组件；只改变数据投影，不改变 `cat` 的真实分类语义。

### 3.3 平板/横屏布局（宽度 ≥ 600dp）

```text
┌────────────┬─────────────────────────────────────┐
│ VRadio     │ TopAppBar：当前目的地 / 搜索 / 更多  │
│ 电台       ├─────────────────────────────────────┤
│ 发现       │ 范围 + 分类 + 内容                   │
│ 收藏       │                                     │
│            │ mini player                          │
└────────────┴─────────────────────────────────────┘
```

rail 固定在左侧，内容区单一滚动；播放条横跨内容区底部，不覆盖 rail。P4 只验收 rail、内容安全区和 sheet 可用，不实现列表/详情双 pane；双 pane 留作后续独立项目。

## 4. 视觉系统与组件规格

### 4.1 设计方向

视觉方向命名为“夜间电波台”：深色以现有 `DarkPal/OledPal` 为主，浅色保持灰白底；绿色 accent 表示可播放/正在播放，橙红表示警告/停运，台标首字母色块作为无图时的稳定识别符。视觉重点放在播放态、台标和状态层级，不引入渐变背景、玻璃拟态或大面积装饰。

### 4.2 Token

先扩展现有 `VrPalette`，组件只读 token，不直接写色值：

```kotlin
data class VrDimens(
  val page: Dp = 16.dp,
  val section: Dp = 12.dp,
  val card: Dp = 12.dp,
  val control: Dp = 48.dp,
  val miniPlayer: Dp = 72.dp,
  val navBar: Dp = 80.dp,
)

data class VrMotion(
  val enterMs: Int = 220,
  val exitMs: Int = 150,
  val listStaggerMs: Int = 0,
)
```

建议 token：

| 用途 | 深色 | 浅色 | 备注 |
|---|---|---|---|
| 页面背景 | `DarkPal.bg` | `LightPal.bg` | 保持 Web/现有 Android 一致 |
| 卡片/播放器 | `DarkPal.panel` | `LightPal.panel` | 只用一层明显 surface |
| 主强调 | `DarkPal.acc` | `LightPal.acc` | 播放、选中、可执行 |
| 警告 | `DarkPal.warn` | `LightPal.warn` | 死台、失败、移动数据门 |
| 分隔线 | `DarkPal.line` | `LightPal.line` | 不用重阴影 |
| 辅助文字 | `DarkPal.dim` | `LightPal.dim` | 仅承载次要信息 |

### 4.3 组件规则

- 所有可操作控件命中区至少 48dp；紧凑的文字动作外层用 `minimumTouchTargetSize` 或 padding 撑开。
- 台标统一单层外框；图片失败继续回退 `StationLogo` 首字母色块。
- 播放态同时使用 accent、图标和文字，不能只靠颜色。
- 列表卡片最多两行主信息 + 一行徽标；URL、诊断 why 等长文本只在详情页显示。
- 动效只用于导航/展开/播放态反馈，进入 220ms、退出 150ms；连接中保留 spinner/pulse，减少无意义列表 stagger。
- 主题继续使用 `radio.theme` 的 `auto/light/dark/oled`，不新增持久键。

## 5. 页面与交互规格

### 5.1 电台库

首屏结构：

1. `TopAppBar`：标题“电台”；搜索图标点击后展开搜索输入；更多菜单提供视图切换、显示无效源、添加电台。
2. 范围 chip：`全部`、`最近`。收藏由独立顶层目的地承载；范围与真实分类继续分离，不能把哨兵写进 `cat`。旧 `★收藏` 哨兵只做兼容读取，新 UI 不写入。
3. 分类 chip：现有 `vm.listUi.chips`，数量与列表同一状态源。
4. 内容：保留网格/列表两种视图；网格使用 `GridCells.Adaptive(160.dp)`，列表使用 `LazyColumn`。
5. 空态：沿用 `listUi.empty` 的现有派生文案，增加可执行按钮：去全部、显示无效源、清空搜索；不把 private `AppVm.emptyMsg()` 暴露给 UI。
6. FAB/更多：添加自定义电台；不在列表首屏长期占据空间。

电台卡片动作：

- 点击：复用 `vm.togglePlay(k)`。
- 长按：复用 `vm.toggleFav(s)`，保留震动。
- 星标：独立 48dp 命中区。
- 详情图标：打开 `vm.openDetail(s)`；低频动作放在卡片的更多按钮或详情页。

### 5.2 Mini player

mini player 是 `AppRoot` 的全局底栏，保留 `PlayerBar` 的状态源，但把操作从“所有动作平铺”改为“一个主动作 + 两个上下文动作”：

- 左侧台标 40dp。
- 中间台名 + 曲讯/状态；曲讯为空时显示连接中、暂停、失败或分类。
- 右侧播放/暂停；连接中显示 spinner。
- 点击中间区域：展开 full player。
- 长按台名：打开 `SourceDetailSheet`，保留现有入口。
- 长按台名不是唯一入口；Full Player 内必须提供可见的“源详情”按钮，TalkBack 用户无需发现长按手势即可进入详情。
- 向上/向下收藏切台、睡眠、源、刷新、分享全部进入 full player 的动作区。

### 5.3 Full player

使用 `ModalBottomSheet` 或 `BottomSheetScaffold`，由 `PlayerSheetState` 控制：

```kotlin
data class PlayerSheetState(
  val expanded: Boolean = false,
)
```

`showSource/showSongs` 不在 `PlayerSheetState` 中重复建模；源和歌曲历史继续由 `AppVm.showSrc`、`AppVm.showSongs` 唯一拥有，root 统一挂载对应 sheet。Full Player 只负责触发 `vm.openSrc()` / `vm.showSongs.value = true`。`PlayerSheetState.expanded` 只表示播放器 sheet 的展开层级。展开层级建议由 `SheetState.PartiallyExpanded/FullyExpanded` 承载，避免再造第三套布尔状态。

播放器文案由组合映射决定，不新增 `PState.ERROR` 或 `PState.NO_ENABLED_SOURCE`：

```kotlin
enum class PlayerAction { PLAY, PAUSE, RETRY, OPEN_DETAIL }
enum class PlayerTone { NORMAL, ACCENT, WARN }

data class PlayerVisual(
  val title: String,
  val action: PlayerAction,
  val tone: PlayerTone,
)

fun playerVisual(ui: PlayerUiState): PlayerVisual = when {
  ui.noSrc -> PlayerVisual("全部源已禁用", PlayerAction.OPEN_DETAIL, PlayerTone.WARN)
  ui.st == PState.CONNECTING -> PlayerVisual(ui.status.ifEmpty { "连接中…" }, PlayerAction.PAUSE, PlayerTone.ACCENT)
  ui.st == PState.PLAYING -> PlayerVisual("正在播放", PlayerAction.PAUSE, PlayerTone.ACCENT)
  ui.st == PState.PAUSED -> PlayerVisual("已暂停", PlayerAction.PLAY, PlayerTone.NORMAL)
  ui.status.isNotBlank() -> PlayerVisual(ui.status, PlayerAction.RETRY, PlayerTone.WARN)
  else -> PlayerVisual("未播放", PlayerAction.PLAY, PlayerTone.NORMAL)
}
```

错误态必须给出 `status` 原因和可执行动作；动作由当前错误上下文选择“重试 / 换源 / 打开详情 / 返回列表”。其中“重试”复用当前台的 `PlayerHolder.refresh()`，“换源”复用 `vm.openSrc()`，“打开详情”复用 `vm.openDetailOf(ui.station?.key)`，“返回列表”复用 `vm.navigate(Destination.LIBRARY)`；UI 不直接新建播放链。

内容顺序：

1. 台标、台名、分类、收藏。
2. 当前播放状态：`连接中 / 正在播放 / 已暂停 / 失败 / 全部源已禁用`。
3. 曲名和码率；HLS 无 ICY 时显示“暂无曲讯”，不能暗示程序异常。
4. 主播放按钮；左右为上一收藏/下一收藏。
5. 次操作：选源、刷新到直播头、睡眠、分享、歌曲历史、详情。
6. 时移回听入口继续使用现有 `TimeshiftRewindButton`，从 `PlayerBar` 迁移到 Full Player 主控制区的次操作行；仍受 B7 开关和组件自判条件控制。
7. 音量滑杆放在主控制下方，继续调用 `vm.setVol` / `vm.toggleMute`。

所有动作复用现有 `AppVm`/`PlayerHolder`，不在 UI 内直接触碰 ExoPlayer。

### 5.4 发现页

将当前 `DiscoverySheet` 平移为正式目的地 `DiscoveryScreen`：

- 顶部说明“本地派生，点击即播”。
- 每个分组使用小标题 + 横向可滚动卡片行；手机每行最多展示 3 张，平板根据宽度自适应。
- 分组为空时不显示空标题；“暂无质量数据”继续作为稳定直连组的说明。
- 点击统一 `vm.startPlay(s)` 并切回 mini player；不要复制播放决策。
- `radio-meta` 未绑定时，“最近新增”显示原因说明，而不是伪造内容。

### 5.5 收藏页

收藏页复用 `StationContent`，只接收收藏集合投影：

- 顶部标题“收藏”，搜索只在收藏集合内执行；分类 chip 只显示收藏集合中实际出现的分类与数量。
- 列表/网格复用 `radio.view`，默认列表视图；收藏页不写入电台页的 `cat`。
- 空态提供“去电台库”入口。
- 取消收藏后立即从当前页移除，并给出约 8 秒可撤销 Snackbar；离开页面后撤销失效，撤销动作以 URL 身份为准，不能按台名回绑。
- 收藏排序沿用既有收藏顺序，最新收藏置顶；不按最近播放隐式重排，也不引入新的持久键。

收藏投影由 `AppVm` 负责，不由 composable 现算：新增进程内 `favoriteUi`/`favoriteListUi`，从 `lib.favs` 按收藏顺序解析 station、再在收藏集合内做 query/category 过滤并生成 chips；UI 只收集该 StateFlow。收藏顶层页是收藏集合的唯一主入口；电台页不再提供 `★收藏` 范围 chip，避免两套搜索/分类状态。

最小数据骨架：

```kotlin
data class FavoriteListUi(
  val list: List<Station> = emptyList(),
  val chips: List<Pair<String, Int>> = emptyList(),
  val empty: String? = null,
  val ver: Int = 0,
)

val favoriteListUi: StateFlow<FavoriteListUi> = combine(favKeys, favoriteQuery, favoriteCategory, stamp) { _, q, c, v ->
  buildFavoriteListUi(q, c).copy(ver = v)
}.stateIn(viewModelScope, SharingStarted.Eagerly, FavoriteListUi())
```

`buildFavoriteListUi` 只能读取 `lib.favs` 的稳定快照和已装配 station；收藏变更、同步重建、配置重套后统一 `stamp++`，不在 composable 内直接遍历可变集合。

### 5.6 设置页

设置改成分组列表，每组是一个可折叠 `SettingsSection`，默认只展开“播放”和“数据与体检”，其余分组折叠：

- 播放：启动续播、音频卸载、时移。
- 外观：主题、网格/列表默认视图。
- 数据与体检：手动体检、检查更新、同步源。
- 网络与流量：移动数据策略、台标 Wi-Fi 优先、会话流量。
- 电台：添加自定义电台、维护配置。
- 备份与导入：备份、恢复、歌单、歌曲历史。
- 关于与反馈：版本、后台播放说明、Issue 入口。

高风险操作统一走现有确认门：移动数据确认、备份覆盖确认、恢复 sidecar 选择。折叠只改变展示，不改变 `AppVm` 状态。

设置页是次级页面；打开时记录来源目的地，系统返回和 TopAppBar 返回都回到来源页。折叠、返回和切换顶层目的地不能停止播放。

### 5.7 源详情与维护

`SourceDetailSheet`（定义在 `ui/SrcSheet.kt` 内）继续作为逐台详情中心，首轮只做视觉和层级优化：

- 头部固定台标/台名/收藏/源数量。
- 当前播放状态和质量摘要置于源列表之前。
- 每个源的主操作只显示“播放/重播”，管理动作收进“更多”。
- 诊断进行中显示进度和取消不可用态；诊断 code 仍以契约枚举为准。
- 排序/禁用仍调用 `vm.srcEdit`，不增加 UI 侧草稿模型。

维护配置编辑继续沿用 `Library`/`CfgCodec`；本轮不把 Web 桌面完整维护面板搬入 Android。

## 6. 状态与代码架构

### 6.1 根状态

在 `AppVm` 保留现有公开 StateFlow，新增 UI 私有态：

```kotlin
enum class Destination { LIBRARY, DISCOVER, FAVORITES }

enum class SecondaryRoute { SETTINGS, ADD_STATION }

data class RootUiState(
  val destination: Destination = Destination.LIBRARY,
  val secondary: SecondaryRoute? = null,
  val secondaryFrom: Destination = Destination.LIBRARY,
  val playerExpanded: Boolean = false,
  val searchExpanded: Boolean = false,
)

data class DestinationUiState(
  val query: String = "",
  val category: String = "全部",
  val grid: Boolean = false,
  val firstVisibleItem: Int = 0,
  val firstVisibleOffset: Int = 0,
)
```

建议实现：

```kotlin
val destination = MutableStateFlow(Destination.LIBRARY)
val secondary = MutableStateFlow<SecondaryRoute?>(null)
val secondaryFrom = MutableStateFlow(Destination.LIBRARY)
val playerExpanded = MutableStateFlow(false)
val searchExpanded = MutableStateFlow(false)
val destinationUi = MutableStateFlow<Map<Destination, DestinationUiState>>(emptyMap())

fun navigate(to: Destination) {
  if (to == Destination.DISCOVER && !FeatureFlags.DISCOVERY) {
    destination.value = Destination.LIBRARY
    return
  }
  destination.value = to
}

fun openSettings() {
  secondaryFrom.value = destination.value
  secondary.value = SecondaryRoute.SETTINGS
}

fun closeSecondary() { secondary.value = null }

fun saveDestinationUi(d: Destination, ui: DestinationUiState) {
  destinationUi.value = destinationUi.value.toMutableMap().apply { put(d, ui) }
}

fun openPlayer() { playerExpanded.value = true }
fun closePlayer() { playerExpanded.value = false }
```

`saveDestinationUi` 只在离开目的地、切换到另一个顶层目的地或进入次级页面前调用；不在 `snapshotFlow` 的每帧滚动回调中写 StateFlow。若需要监听滚动，只在离开前读取 `LazyListState.firstVisibleItemIndex/firstVisibleItemScrollOffset` 做一次快照。

不把这些 UI 瞬态写入 `radio.*`。页面搜索/分类/滚动只在进程内保存，进程被杀后恢复默认；旋转重建期间可用 `rememberSaveable` 保留当前组合，但不承诺进程死亡恢复。

### 6.2 自适应 Scaffold

首轮不新增 adaptive navigation 依赖，直接按 `screenWidthDp` 选择导航形态：

```kotlin
enum class VrWindow { COMPACT, EXPANDED }

@Composable
fun rememberVrWindow(): VrWindow {
  val cfg = LocalConfiguration.current
  return if (cfg.screenWidthDp >= 600) VrWindow.EXPANDED else VrWindow.COMPACT
}

@Composable
fun VrScaffold(
  destination: Destination,
  onNavigate: (Destination) -> Unit,
  player: PlayerUiState,
  content: @Composable (PaddingValues) -> Unit,
) {
  val window = rememberVrWindow()
  Scaffold(
    bottomBar = {
      Column {
        MiniPlayer(player, onOpen = { /* vm.openPlayer() */ })
        if (window == VrWindow.COMPACT) VrBottomNav(destination, onNavigate)
      }
    },
  ) { pad ->
    Row(Modifier.fillMaxSize()) {
      if (window == VrWindow.EXPANDED) VrNavigationRail(destination, onNavigate)
      Box(Modifier.weight(1f).fillMaxHeight()) { content(pad) }
    }
  }
}
```

每个 Screen 必须接收并应用 `PaddingValues`，不能写 `{ _ -> }` 丢弃它：`StationScreen(vm, pad)`、`FavoritesScreen(vm, pad)`、`DiscoveryScreen(vm, pad)`、`SettingsScreen(vm, pad)`。`Scaffold` 的 padding 必须同时计入状态栏、导航栏和 mini player 实际高度；不能使用固定底部 padding，否则小屏字体放大或横屏时会遮挡列表。

### 6.3 Bottom navigation 与 rail

```kotlin
private val destinations = listOf(
  Destination.LIBRARY,
  Destination.DISCOVER,
  Destination.FAVORITES,
)

@Composable
fun VrBottomNav(selected: Destination, onNavigate: (Destination) -> Unit) {
  NavigationBar {
    destinations.filter { it != Destination.DISCOVER || FeatureFlags.DISCOVERY }
      .forEach { d ->
        NavigationBarItem(
          selected = selected == d,
          onClick = { onNavigate(d) },
          icon = { DestinationIcon(d, selected == d) },
          label = { Text(d.title) },
        )
      }
  }
}

@Composable
fun VrNavigationRail(selected: Destination, onNavigate: (Destination) -> Unit) {
  NavigationRail {
    destinations.filter { it != Destination.DISCOVER || FeatureFlags.DISCOVERY }
      .forEach { d ->
        NavigationRailItem(
          selected = selected == d,
          onClick = { onNavigate(d) },
          icon = { DestinationIcon(d, selected == d) },
          label = { Text(d.title) },
        )
      }
  }
}
```

图标继续使用现有自绘 Canvas 或 Material3 已有图标；不要为三枚导航图标引入图标库。

### 6.4 Root 组装骨架

```kotlin
@Composable
fun AppRoot() {
  val owner = LocalContext.current as ViewModelStoreOwner
  val vm = remember(owner) { ViewModelProvider(owner)[AppVm::class.java] }
  val destination by vm.destination.collectAsState()
  val player by PlayerHolder.ui.collectAsState()
  val expanded by vm.playerExpanded.collectAsState()

  VrTheme(vm.theme.collectAsState().value) {
    VrScaffold(
      destination = destination,
      onNavigate = vm::navigate,
      player = player,
    ) { pad ->
      when (destination) {
        Destination.LIBRARY -> StationScreen(vm, pad)
        Destination.DISCOVER -> DiscoveryScreen(vm, pad)
        Destination.FAVORITES -> FavoritesScreen(vm, pad)
      }
    }
    if (vm.secondary.collectAsState().value == SecondaryRoute.SETTINGS) SettingsScreen(vm)
    if (expanded) PlayerSheet(vm, player)
    if (vm.showSrc.collectAsState().value) SrcSheet(vm, player)
    if (vm.showSongs.collectAsState().value) SongsSheet(vm, player)
    if (vm.showDetail.collectAsState().value) DetailSheetFromExistingState(vm, player)
  }
}
```

正式编码时不要在 `when` 分支内重新创建 ViewModel 或播放器；所有浮层仍由 root 统一挂载，保证切换目的地不会丢播放上下文。`BackHandler` 按确认弹窗、播放器/详情 sheet、次级页面、顶层页面的顺序消费返回事件。

## 7. 文件级落地清单

### P0：导航和 token 基础

- 新增 `ui/Navigation.kt`：`Destination`、`VrWindow`、bottom nav、rail、图标。
- 新增 `ui/VrScaffold.kt`：根布局、窗口宽度判断、mini player 占位和内容 padding。
- 修改 `ui/AppVm.kt`：目的地、playerExpanded、searchExpanded、navigate/open/close。
- 修改 `ui/AppRoot.kt`：接入 `VrScaffold`，保留现有浮层 root 挂载。
- 修改 `ui/theme/Theme.kt`：补 `VrDimens`/`VrMotion` CompositionLocal；不改现有颜色值。
- 保留 `Nav` 旧枚举一个过渡批次，迁移完成后删除；迁移期间不能出现两套目的地状态同时驱动 UI。

### P1：电台库和 mini player

- `StationList.kt` 拆成 `StationScreen.kt` + `StationContent.kt`（只做文件职责拆分，不改 `AppVm` 过滤语义）；`Nav` 旧枚举在 P0 同一 PR 内删除，避免中间态合入。
- 搜索输入迁移到 TopAppBar 的可展开搜索；`StationList.kt` 现有 `LaunchedEffect(q) { delay(120) ... }` 防抖逻辑必须随行迁移到 `StationScreen`/对应页面状态，不得误移到 UI 外或丢失。
- 新增 `MiniPlayer.kt`，从 `PlayerBar.kt` 提取状态映射；旧 `PlayerBar` 暂保留为 full player 控件复用层。
- 内容列表补偿 `contentPadding`，实测 320×720、360×800、390×844、横屏 800×360。

### P2：full player 和详情层

- 新增 `PlayerSheet.kt`：台标、状态、曲讯、主控制、收藏切台、源/歌史/睡眠/刷新/分享入口。
- `PlayerBar.kt` 改为纯控制组件，所有动作继续调用现有 API。
- `SrcSheet.kt`、`SongsSheet.kt` 以及同文件内定义的 `SourceDetailSheet` 只做容器层级和动作密度调整；不改诊断 code、srcorder、质量 sidecar。

### P3：发现页和设置页分组

- 新增 `DiscoveryScreen.kt`，从 `DiscoverySheet.kt` 提取纯展示组件；P3 同一批把 `FeatureFlags.DISCOVERY` 从 `false` 翻为 `true`，并完成导航项、Screen、测试和旧浮层入口的迁移，避免发布半成品。
- `SettingsScreen.kt` 引入 `SettingsSection`、`SettingsRow`、`SettingsActionRow`；SAF launcher 和确认门逻辑保留在屏幕层。
- 添加台入口统一为设置次级页，同时允许电台页更多菜单直达；不新增顶层导航目的地。

### P4：大屏和可访问性收口

- 平板 rail 与内容最大宽度实测；P4 只验收 rail、Mini Player、sheet、内容安全区和横屏可用，不实现列表/详情双 pane。
- 为所有自绘控件补 `semantics { contentDescription = ... }`、selected/disabled 状态和 role。
- 接入系统返回：full player → detail/source/songs → destination child → root；不覆盖系统 predictive back 默认动画。
- 补 dark/light/OLED、字体放大、横屏、TalkBack、强制深色、离线、空态、错误态验收。
- P0–P4 连续完成后统一跑 fixture、旋转和后台播放硬门；不把“视觉完成”当作批次完成条件。

## 8. 测试与验收

### 8.1 纯 JVM

新增或扩展：

- `NavigationStateTest`：FeatureFlags 关闭时发现目的地回退、电台/设置切换、返回栈纯函数。
- `WindowClassTest`：599/600/839/840dp 断点口径；不同窗口不改变业务数据。
- `PlayerUiMappingTest`：覆盖 `PState × noSrc × status` 组合映射：CONNECTING、PLAYING、PAUSED、普通 IDLE、`IDLE + status` 错误、`IDLE + noSrc=true` 全部源已禁用；不得新增 `PState.ERROR` 或 `PState.NO_ENABLED_SOURCE`。`emptyMsg()` 保持 `AppVm` private，测试通过 `listUi.empty` 验证空态文案。
- `SettingsSectionTest`：分组折叠只影响 UI 展示，不改变 Prefs/Store 键。

### 8.2 Instrumented smoke

在现有 `AndroidSmokeTest`、`PlaybackSmokeTest`、`BackupRestoreSmokeTest` 之上增加：

1. 启动后默认到电台页，点击设置再返回，来源页搜索词和滚动位置保留。
2. fixture 播放后切换到发现/收藏/设置，音频不中断，mini player 台名和状态持续更新；设置返回原目的地。
3. 展开 full player，点击刷新/选源/歌史，动作回到现有 PlayerHolder/AppVm。
4. 320dp 手机与 800dp 横屏分别确认底栏/rail 不遮挡内容。
5. 无网络时列表、收藏、最近、备份入口可用；探活/同步错误有明确恢复动作。
6. 收藏页搜索和分类只作用于收藏集合；取消收藏立即移除，Snackbar 撤销按 URL 恢复。
7. P0–P2 编译期 `DISCOVERY=false` 时，底部导航/rail 只剩电台与收藏且无空位；P3 翻为 `true` 后，DiscoveryScreen、导航项和测试同批可见。不能用运行时开关测试替代编译期两次构建验证。
8. 电台与收藏之间切换后，各自搜索词、分类和滚动位置保留；设置返回来源页。
9. TalkBack 可读出目的地、播放状态、收藏状态、禁用源和确认弹窗按钮。

### 8.3 性能门

- 电台列表继续使用 LazyColumn/LazyVerticalGrid + 稳定 key。
- 首屏不同时启动全库台标请求；收藏和正在播补全策略不变。
- 目标：常见 1600 台数据下滚动无明显掉帧；搜索防抖保持 120ms；UI 状态更新不能在 composable 内启动重复网络任务。
- `assembleDebug`、`./gradlew test` 和现有 Android smoke 必须通过；若新增依赖，必须额外记录 APK 增量。

## 9. 风险与决策门

| 风险 | 处理 |
|---|---|
| 新增 adaptive 依赖扩大白名单 | P0 不引入；P4 单独评审 |
| mini player 与 MediaSession 状态不一致 | 只收集 `PlayerHolder.ui`；不在 UI 自建播放状态 |
| 底栏遮挡列表 | 以 Scaffold 实际 padding + 设备矩阵验收 |
| 发现页和 Web 语义漂移 | 继续调用 `AppVm.discovery` / `startPlay`，不复制派生逻辑 |
| 设置页重构误改持久键 | 所有写入仍走现有 `Prefs`/`Store`，不新增 `radio.*` |
| full player 动作过密 | 首屏只保留播放/切收藏；其余进入次级动作区 |
| 平板双 pane 增加状态复杂度 | P4 明确不做双 pane；保留 sheet，另立后续项目 |
| 自绘图标可访问性不足 | P4 为所有 Canvas/文字图标补语义和测试 |

## 10. Review 要点

### 已确认决策（Grill round 1–4）

1. 顶层导航为“电台 / 发现 / 收藏”；发现关闭时隐藏发现项，电台与收藏保留。
2. 收藏页独立搜索，分类仅来自收藏集合；最新收藏置顶；取消收藏立即移除并提供约 8 秒 Snackbar 撤销，离开页面后失效。
3. mini player 只保留台名、曲讯、播放/暂停；其他动作进入半屏起步、可拖到全屏的 full player。
4. 首轮不引入 `material3-adaptive-navigation-suite`；P4 再评估。
5. 设置是次级页面，返回进入前的原顶层目的地；添加电台从设置进入，也可由电台页更多菜单直达。
6. 顶层页面的搜索/分类/滚动状态仅在进程内保留；进程被杀后恢复默认，不新增 `radio.*` 键。

以下旧条目中的“电台 / 发现 / 设置”表述以本节已确认决策为准；后续编码不得恢复设置顶层导航。

### 已确认的交付硬门

- 任意顶层导航、旋转、Full Player 展开/收起、设置/添加电台进入退出都不能中断播放。
- 返回按层级消费，不能无条件跳回电台首页。
- 错误状态必须显示原因和恢复动作，不能只显示“失败”。
- P0–P4 连续实施；每批保留可回归提交和验证记录。P0 同一 PR 内删除旧 `Nav` 枚举，不能把“保留过渡批次”理解为允许旧状态跨批次存在。
- 合入前必须通过 JVM、Android fixture smoke、320/390dp 手测、旋转和后台播放。

### Grill 完成结论

信息架构、播放器层级、收藏语义、自适应导航策略、设置层级、返回栈、错误恢复、实施节奏和验收硬门均已完成决策。未决项只剩后续项目范围，不阻塞本方案编码：平板列表/详情双 pane、adaptive navigation suite 引入，以及更复杂的窗口姿态适配。

后续 owner review 只需检查上述已确认决策与代码骨架是否一致；平板双 pane、adaptive suite 和复杂窗口姿态属于后续项目范围。


## 11. 外部资料与项目依据

- Android Developers：Build adaptive navigation
- Material Design 3：Navigation rail
- Android Developers：Media controls
- Android Developers：Getting started with Compose-based UI for Media3
- `AGENTS.md`：Web/Android 共同契约、模块所有权和测试纪律
- `android/README.md`：Android 分层、依赖白名单、Widget、网络策略和 instrumented fixture
- `android/CONTRACTS.md`：跨端契约和 UI/播放器边界
- `docs/ui-redesign-plan-2026-11.md`：Web UI token、筛选、续听、详情、维护和验收基线
- `docs/plan-android.md`、`docs/plan-expansion-r4.md`：Android 路线与 r4 扩展背景

