# Android B.3 服务与自连：审计、设计候选及测试计划

状态：专项设计待评审，**不是 B.3 完成证明**。基于 `origin/feat/b-android-follow` 的 `bcf7327` 静态检查；没有执行模拟器或真机测试，也没有安装 APK。本文不修改播放器行为。

## 现状与证据边界

- Manifest 的 `PlaybackService` 为非导出 mediaPlayback 前台服务；`VRadioApp.onCreate` 先初始化 Store，再 `PlayerHolder.ensure`。`PlayerHolder` 持有进程级 ExoPlayer、MediaSession，自连控制器；`PlaybackService.onGetSession` 返回此 session，自己的 `onDestroy` 只取消 Widget 协程并调用父类。
- `ensure` 的 `inited` 使每进程只初始化一次。自连只 `buildAsync` 一次，future 失败被吞，成功后赋值给私有 `selfCtl`，没有断连监听或重试入口。故首次连接失败或同进程中自连后来真正断开时，应用代码没有主动恢复自连的路径。服务是否真的销毁、Media3 是否自行恢复、用户何时受到影响，均不能由这段代码推定；尤其不能断言播放一定中断。
- 对本地缓存的 Media3 1.11.1 AAR 用 `javap` 检查：`MediaController.Builder.setListener` / `setApplicationLooper`、`MediaController.Listener.onDisconnected`、`isConnected`、`releaseFuture` 均存在。父类 `MediaSessionService.onTaskRemoved` 字节码在非前台进行中的播放时调用 `pauseAllPlayersAndStopSelf`；后者对 session player 执行 `setPlayWhenReady(false)` 然后 `stopSelf`；父类 `onDestroy` 释放 service stub。这只是所用版本实现证据，不代表全部 Android 系统时序或必然触发断连。
- `Prefs.RESUME` 默认 false；AppVm 启动末梢先处理快捷方式/链接，再在开关开启且无当前台时尝试最近台。用户开启自动续播是例外；不能宣称任何重启均不自动播放。已有 Library JVM 用例只覆盖最近条目回绑与失配，不覆盖启动播放行为。
- `stopService` 返回成功不证明仍被绑定的服务已销毁；另建测试 controller 连上也不能证明产品自连已恢复。必须分别观测实际销毁、产品自连和 session 关联。

## 风险与推荐方向（待专项评审）

对任意 `onDisconnected` 盲目反复 `buildAsync` 可能重新绑定并重建用户或系统有意停止的服务；若播放器仍在播，还可能触及通知、前台服务启动策略。退避只能限频，不能判断断连意图。不要改写 `onTaskRemoved` / `onDestroy`，不要释放进程级 session 或 ExoPlayer，也不要把控制器连接成功当作恢复后台通知的证明。

推荐先设计**由明确用户播放意图触发**的自连补建：现有连接健康或连接在途则复用，已断连或失败才单飞创建；连接动作本身绝不调用 play/prepare、改变 station、playWhenReady 或覆盖暂停。明确区分原有启动时首次自连、用户主动播放以及自动续播或媒体命令等入口；哪些入口具备重新绑定资格须先评审，不能把所有回调视作用户意图。该方案不承诺播放中服务意外断开后无交互自动恢复，属于明确遗留范围，不能冒充完整 B.3 修复。

实现前应明确：主线程串行与 Media3 application looper；in-flight future 和已连接 controller 的唯一所有权；断连与异步完成交错时的 generation、旧结果释放和重复回调；失败可观测但不得无限后台重试；`releaseFuture` 的线程要求、取消与完成时序须以本版本 API 文档及设备验证；日志不暴露 URL。禁止为测试绕过平台服务生命周期或在生产中引入仅供测试的强制播放。

## 可执行测试计划（待实现，非已有通过结果）

1. 抽取不依赖 Android 的连接协调状态机，注入 fake connector、调度器与资源释放回调；接入实际 Media3 adapter 前，运行 `cd android && ./gradlew test`。测试连接单飞、失败后仅新授权意图重试、已连接时幂等、断连后不自行重试、旧代迟到成功的资源释放、重复/过期断连无副作用；断言无播放命令。应覆盖连接尚未完成即断连、同步抛错、取消与释放各竞态，避免只测理想异步顺序。状态机通过不代表 adapter 或系统行为正确。
2. 使用隔离模拟器和本地 fixture，运行 `compileDebugAndroidTestKotlin` 后再按项目 fixture 协议执行 instrumentation。需建立可靠的服务销毁观测与产品自连状态观测：先证明原服务 `onDestroy`、原 controller 断连，再记录何种明确用户意图触发重连，确认新服务返回原有未释放 session；检查无重复 controller、无多次服务实例残留及暂停状态未变。未能触发或观测前置条件应 fail/明确 skip，不能记成功。不要仅凭 `stopService` 或外部测试 controller 推断。
3. 用隔离测试数据的最近台构造启动测试：设置键不存在、最近台可解析、无快捷方式或链接意图；通过可靠 boot 完成信号等待启动末梢，验证持续观察窗口内无播放请求、播放器无当前台/未准备播放；再单独测试用户明确开启续播和显式续听。不得用固定 sleep 代替启动完成证明，也不得接公网。既有数据 guard 不构成允许操作用户设备的授权。
4. 单列设备矩阵：系统版本、冷/热进程、后台与通知权限、task 移除、进程回收、音频焦点及长听；记录设备、步骤、日志与实际结果。B.7 设备验收仍须另行完成。

## 本次本地验证

在隔离 worktree 执行 `gradlew.bat --offline test compileDebugAndroidTestKotlin` 成功；JVM test 任务由 Gradle 缓存提供，instrumentation Kotlin 编译通过。没有执行 connected 测试，未向任何设备安装。此结果只证明该基线在本环境的离线构建/缓存可用，不证明上述候选方案或设备行为。
