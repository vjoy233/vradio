# B.3 自连补建安全评估（未实施）

状态：**未证明安全，因此不修改产品代码**。本报告基于 PR #68 的 `05b87000f0575f58cfd4265b826591abceaa0b96`；B.3 未完成。未执行模拟器或真机验证，未安装 APK；不能据此声称通知、服务生命周期或播放恢复可靠。

## 范围与结论

目标仅为明确用户播放意图后，首次自连失败或后来断开时单飞补建；连接本身不得播放、后台重连、释放共享 ExoPlayer/MediaSession 或改变暂停意图。不能把自动续播、播放器错误、焦点恢复或定时器当作新的用户授权。本次没有实现状态机或接线：仅凭 JVM fake 可证明单飞算法，无法证明真实服务重建与共享 session 复用满足上述约束。尤其不能把外部控制器连接成功或 `stopService` 返回成功误判为产品自连和服务已重建。

## 代码和 Media3 1.11.1 实证

- `PlayerHolder.ensure` 进程启动时只建立一次异步自连并吞掉失败；没有断连监听或补建。该事实不证明播放必然中断。
- `PlayerHolder.play` 被 `AppVm` 普通播放和启动自动续播共同使用；`resumeLastIfWanted` 也进入 `resumeLast`，故在通用 `play` 无条件重连会扩大到自动续播，违反本次限定。`toggle` 同时可来自 UI 和 Widget session 命令；媒体命令、快捷方式等应按真实调用来源逐一标注，而不是假设每次公共方法调用均为显式用户操作。
- [MediaController 1.11.1 源码](https://github.com/androidx/media/blob/1.11.1/libraries/session/src/main/java/androidx/media3/session/MediaController.java)：`buildAsync()` 的 future 必须保留直到完成；Listener 在 application looper 调用；`onDisconnected` 以后 controller 不可用，且主动 `release()` 也会触发该回调；`releaseFuture` 必须在 controller application thread 调用，未完成时取消，否则释放结果。故必须主线程串行，先作废世代，再清理，防重入及过期回调释放新对象；不能对共享 player/session 使用 release。
- [MediaSessionService 1.11.1 源码](https://github.com/androidx/media/blob/1.11.1/libraries/session/src/main/java/androidx/media3/session/MediaSessionService.java)：服务 `addSession` 会注册 notification manager 并覆盖 session listener；`onDestroy` 释放 service stub，但源码本身不能证明 Android 上原绑定已解除、旧服务彻底销毁或新旧 listener 与通知回调无交叠。[MediaNotificationManager](https://github.com/androidx/media/blob/1.11.1/libraries/session/src/main/java/androidx/media3/session/MediaNotificationManager.java) 为每个 session 另建异步 controller，连接失败可移除 session。产品自连的单飞并不等于服务内部控制器与通知生命周期的单飞。
- 服务连接可能使 Media3 重新管理通知与前台生命周期；仅声明“连接动作不调用 play”不足以证明平台侧不会影响暂停意图或造成前后台服务问题。特别是异步旧 controller 完成、断连、service 销毁与共享 session 再挂载交叠时，目前没有设备实验证明。

## 下一步证明条件

1. 定义显式意图入口与传递方式，覆盖台列表、续听、刷新、快捷方式、媒体键和 Widget；明确排除自动续播、焦点恢复及故障自愈。新入口在停播/暂停时不得自行改播放意图，保留原有各动作语义。
2. 提取纯 Kotlin 状态机：强持有 future；主 looper 上单飞；连接失败只等待下一次授权；代号 + 身份防止旧完成或断连覆盖新代；失效对象仅释放自己，并对同步异常、取消、完成前断连及 release 重入测试。fake 必须断言绝不向 player/session 发命令。再验证真实 Media3 适配器，不能仅测试投影。
3. 隔离数据与本地 fixture 下观测原 service `onDestroy`、产品自身 controller `onDisconnected` 和新 service 的原 session 关联；测重连前后 `playWhenReady`、台及共享对象身份，覆盖暂停、连播、连续授权、旧结果迟到与任务移除。前置条件未观测到即失败或明确跳过。还需确认通知/前台限制、系统版本、音频焦点和长听。设备未验证前不宣称 B.3 修复完成。

## 本次验证

独立 worktree 以 PR #68 head 检出。首次运行 `gradlew.bat --offline test` 因独立 worktree 未配置 SDK 失败（`SDK location not found`）；设置已有 SDK 的 `ANDROID_HOME=D:\\Dev\\android-sdk` 后通过，任务大量 `FROM-CACHE`，这是**基线 JVM 测试**，不是新方案或 adapter 验证。没有新增产品单元测试、没有设备验证。研究结论和候选测试计划不能替代实现与实测。
