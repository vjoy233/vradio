# Android v1.2 Batch B 静态审计与测试证据

范围：已合并代码；未进行模拟器或真机操作。规格以实施计划 v1.2 B 节为准，不把 JVM 测试当作发布验收。

- **轻更新**：`LightUpdate.apply` 先写 radio，随后尽力写 logos/meta，最后尽力写 stamp，并非跨文件事务。logosChanged 表示下载非空，不能证明写成功；meta 不可用时尽力删除旧文件，绑定须经 stamp 和内容哈希核验。新增 JVM 故障注入覆盖 radio 临时文件写失败保留旧批次、logos 写失败但 radio 生效、stamp 写失败后旧见证被哈希拒绝且可重新检查；已有用例覆盖 meta 写失败、非法/缺失及旧 stamp。写失败保旧测试针对临时文件写失败，不能推广为所有磁盘故障：共享 `writeTextAtomic` 在 rename 失败时还有删除旧目标和直写兜底，无法保证该路径中断时旧文件完整。
- **服务**：Manifest 声明 mediaPlayback 前台服务与权限；Application 初始化 PlayerHolder，单例持有 ExoPlayer/session，自连 controller；PlaybackService 返回该 session，销毁时只取消服务自己的 Widget 协程，未改动 Media3 生命周期。服务销毁后重连、自连失败、系统杀进程与通知行为尚无本轮运行证据，须模拟器/设备专项验证，不推断已通过。
- **续听**：`Prefs.RESUME` 默认 false；启动末梢以快捷方式、链接意图优先，其次才按设置自动续播；显式播放上次不依赖该开关。最近条目经 Library 回绑并解析，失配不构造幽灵台。开启设置后允许自动播放，因此不能笼统宣称进程恢复永不自动起播；默认关闭与用户主动开启应分别验收。
- **选源与诊断**：禁用源不能点播或诊断，详情按启用序分批最多四路探测；诊断仅记录质量样本，不修改 health。源记忆恢复与人工排序重置分开；已有 `CfgSourceLifecycleTest`、`CheckStreamTest`、`DiagnosticModelTest` 覆盖纯逻辑/契约，不能代替 Compose 交互与异步生命周期实测。
- **续听数据测试补充**：JVM 覆盖最近条目以次源 URL 回绑改名台、回绑后去重与持久重载，以及失配条目保留快照但不能解析为幽灵台。此证据仅覆盖 Library 数据层，不覆盖启动意图优先级、播放器或系统生命周期。
- **后置项**：锁屏长听、音频焦点/耳机、后台通知、进程回收/恢复、弱网、覆盖升级及发布签名等 B.7 门仍未验证。此次不引新依赖、不重写服务/UI。
