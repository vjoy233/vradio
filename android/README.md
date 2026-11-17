# VRadio 安卓版（android/）

原生 Kotlin + Jetpack Compose + Media3 的移动收听形态（方案与决策记录见 [../docs/plan-android.md](../docs/plan-android.md)，技术路线论证见 [../docs/adr/0001](../docs/adr/0001-android-native-route.md)）。与 Web 版**数据同源、格式互通、代码不共享**：`radio.txt`/`logos.txt` 由仓库根 `update-sources.js` 产出、两侧共同消费，`radio.*` 13 个持久键与 `vradio-backup.json` 是两侧共同契约（改任一侧须同步另一侧，AGENTS.md 契约节）。

## 常用命令（android/ 目录内）

```bash
./gradlew test             # 纯 JVM 单测（parser/classifyCn 金样/store/cfg/backup/health，秒级离线）
./gradlew assembleDebug    # 出 debug APK（app/build/outputs/apk/debug/）
./gradlew assembleRelease  # 出 release APK（R8 收缩；签名见下方发布节）
```

构建时自动把仓库根 `radio.txt`/`logos.txt` 拷进 assets 并写 `data-stamp.txt`（D7 轻更新判新旧的打包基线）。

## 版本迭代手动打包（例行流程，Git Bash）

每次发新版本四步（环境已按下方环境节装好时，全程两三分钟）：

1. **改版本号**：`app/build.gradle.kts` 的 `defaultConfig` 里 `versionCode + 1`、`versionName` 改新版本（如 `0.2.0`）——versionCode 只增不减（安卓系统靠它判断升级/降级），versionName 是给用户看的。
2. **构建**：
   ```bash
   cd /d/Vibing/vradio/android && source env.local.sh   # 设 JAVA_HOME/ANDROID_HOME（本机一次性配好）
   ./gradlew test assembleRelease                        # 先单测再出包，挂了就不发
   ```
3. **拿包安装**：产物在 `app/build/outputs/apk/release/app-release.apk`（无 keystore 时自动 debug 签名，可直接装）。拷到手机点击安装（覆盖升级，个人数据在 filesDir 不受影响）；或 `adb install -r app-release.apk`。自用日常迭代也可用 `assembleDebug` 的 debug 包，但要先卸载 debug 包再装 release 包（两者签名不同不能互相覆盖，卸载会清数据——**固定用一种签名最省事**）。
4. **对外发布（可选，M5 口径）**：GitHub Release 附 APK + **sha256 置顶**（`sha256sum app-release.apk`），Release 说明附国内加速下载指引；正式签名先配 `android/keystore.properties`（四键见下方发布节，**生成即双备份，丢失 = 无法续签升级**）。

> 数据随版本：电台库在 assets 里随包走（构建时从仓库根拷入），用户收藏/配置等在应用私有目录不受升级影响；老用户想刷最新电台数据不必等发版——app 内「设置 → 检查数据更新」走 D7 通道直接拉仓库 main 的 radio.txt/logos.txt。

## 环境搭建（M-1 环境闸口，国内镜像，换机照抄）

本工程**全程 gradle CLI 可跑、无 IDE 依赖**。Windows + Git Bash 口径（Linux/macOS 同理换路径）：

1. **JDK 17**（Temurin，清华镜像，不追 21——AGP 8.x 基线）：
   `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip`
   解压到 `D:\Dev\jdk17`。
2. **Android cmdline-tools**（dl.google.com 国内可达）：
   `https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip`
   解压到 `D:\Dev\android-sdk\cmdline-tools\latest`（注意必须叫 latest）。
3. **SDK 组件**（⚠ Git Bash 下包名的 `;` 会被 cmd 吃掉，用 `/` 形式）：
   ```bash
   export JAVA_HOME="D:/Dev/jdk17"
   cd /d/Dev/android-sdk
   yes | cmdline-tools/latest/bin/sdkmanager.bat --sdk_root=D:/Dev/android-sdk --licenses
   cmdline-tools/latest/bin/sdkmanager.bat --sdk_root=D:/Dev/android-sdk "platform-tools" "platforms/android-36" "build-tools/36.0.0"
   ```
4. **gradle 发行版**（wrapper 的 `distributionUrl` 已钉腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/gradle-8.14.6-bin.zip`，首次构建自动拉）。
5. **maven 仓库序**：`settings.gradle.kts` 已钉 Aliyun（google/central/gradle-plugin）优先、官方源兜底。
6. `local.properties` 写 `sdk.dir=D\:\\Dev\\android-sdk`（gitignored）；
   可选 `env.local.sh`（gitignored，模板）：
   ```bash
   export JAVA_HOME="D:/Dev/jdk17"
   export ANDROID_HOME="D:/Dev/android-sdk"
   ```

版本基线（2026-10 锁定）：AGP 8.13.2 / Kotlin 2.2.21 / Gradle 8.14.6 / compose-bom 2026.06.01（09.00 的 material-ripple 要求 compileSdk 37 > AGP 8.13 上限 36，故钉 06.01）/ core-ktx 1.17.0（同理）/ Media3 1.11.1 / minSdk 26 / target & compileSdk 36。**依赖白名单封闭清单制**（plan §四）：新增运行时依赖一律先议事；okhttp 是 D6 拍板的唯一运行时破例（Icecast `ICY 200 OK` 非标状态行）。测试专用的 `androidx.test.ext:junit`、`androidx.test:runner`、`androidx.test:rules` 只挂在 `androidTestImplementation`，不扩大运行时依赖白名单；新增测试依赖必须在 PR 说明登记。

**测试依赖登记（review#40-r2 P3，批准范围 = 测试配置、不入运行时白名单）**：纯 JVM 单测（`testImplementation`）= junit 4.13.2 / org.json 20250107 / kxml2 2.3.0（后两个是 android.jar 抛异常桩的真实现替身，设备运行时用平台内置、不进 APK）；instrumented smoke（`androidTestImplementation`）= androidx.test.ext:junit 1.2.1 / androidx.test:runner 1.6.2 / androidx.test:rules 1.6.1（无 espresso）。版本锁定随上表基线同制，新增测试依赖一律 PR 说明登记；离线构建 = `./gradlew --offline`（`test`/`compileDebugAndroidTestKotlin` 均可离线跑，gradle 依赖缓存须先热）。

## 模块结构（对应 Web 五文件精神的分层，语义契约见 ../CONTRACTS.md）

```
app/src/main/java/io/github/vjoy233/vradio/
  consts/  全部常数集中（每条注 Web 侧出处，防双端漂移）
  model/   Station/Cfg/HealthEntry… 与 Web JSON 持久格式一一对应
  data/    RadioTxt 解析 / Store（13 键 filesDir JSON，tmp+rename）/ MyRadio / Cfg / Library（装配管线+持久态）/ Backup（导入导出五件套）/ Logos（台标三级来源）/ Starter（精选层）
  player/  PlayerHolder（ExoPlayer 封装+决策链+断流自愈+ICY）/ PlaybackService（MediaSessionService）
  ui/      Compose：列表双视图/搜索/分类/收藏/最近/播放条/选源浮层/歌史/设置/添加电台
  check/   CheckStream（字节验收四常数钉死）/ Health（死台分档生命周期）
  sync/    Gh（api.github.com 客户端）/ ClassifyCn（金样平价移植）/ LightUpdate（D7 轻更新）/ SyncEngine（M4 端内同步）
  widget/  桌面 Widget（B5）：RadioWidgetProvider/WidgetCommands/WidgetPush + WidgetState（纯 JVM 快照/节流/切台逻辑）
  network/ 网络策略与流量估算（B5，纯 JVM）：NetworkPolicy（NetProbe 注入）/ TrafficEstimator
```

数据层/体检同步层/widget 纯逻辑/网络策略层为纯 JVM（不 import android.*），单测离线秒级（对齐 Web 侧 `npm test` 口径）。

## 桌面 Widget 与网络策略（B5，plan-expansion-r4 §9）

- **Widget**：桌面长按 → 小部件 → 「VRadio 电台」（4×1 起步可横向拉宽）。显示当前台名/首字母色块/曲讯一行，
  按钮 = 上一收藏/播放暂停/下一收藏，点非按钮区打开应用。控制经 MediaSession 自定义命令进现有播放链
  （进程被系统回收后点击会自动唤醒）；进程不在时显示最近快照。Widget 本身**不主动联网**；
  快照存 Android 私有键 `widget.snap`（**不进 radio.\* 契约、不进备份**，换机/清数据即清空属预期）。
  台标第一版为首字母色块（RemoteViews 加载网络图不可靠，位图化在后续版本）。
- **网络策略**（设置 → 网络与流量）：**播放任何网络都不拦**；单台探活移动数据放行但提示；
  全量体检/主库同步在移动数据下默认「每次确认」（可改允许/禁止）；台标补全 Wi-Fi 优先（可关）。
  会话级流量估算按已知码率（无 ICY 码率时按 128kbps 并标注「估算」）30 秒采样累计，非精确计费。
  策略设置存私有键 `net.*`（同样不进契约/备份）。

## instrumented smoke 与本地 fixture 协议（P2，docs/testing-strategy-2026-11.md §3 L4）

instrumented smoke（`app/src/androidTest/`：启动/资产 + 播放控制 + 备份导入）走「本地固定流 fixture」协议，禁止依赖公网：

- **fixture**：仓库根 `node test/harness/android-fixture.js`（零依赖 Node 内置 http，监听 0.0.0.0 随机端口）。
  启动即打印 `FIXTURE_URL=http://127.0.0.1:<port>` 与 `FIXTURE_VERSION`；`--list` 打印路由清单（与测试断言对账）；
  测试编排可 `require()` 其 `start()`。场景：直流 MP3×2（点播/切台）、ICY（icy-metaint=32 + icy-br + StreamTitle 换歌两帧）、
  HLS master→variant→相对分片（真帧可解）、延迟建流 1.5s、断流 destroy、336B 假流、HTML 错误页、`__health` 自检。
- **fixtureBaseUrl 注入**：模拟器访问宿主回环的固定映射是 `10.0.2.2`——workflow/本机把 127.0.0.1 换算后
  `./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.fixtureBaseUrl=http://10.0.2.2:<port>`
  （AGP 官方 instrumentation 参数机制）；真机在同一局域网时直接填宿主机地址，并在报告记录实际 URL。
- **缺省 skip 语义**：测试读 `InstrumentationRegistry.getArguments().getString("fixtureBaseUrl")`；
  未传参或等于哨兵值 `http://10.0.2.2:0`（端口 0 不存在）时，播放类用例经 JUnit4 `Assume` 跳过——
  没接 fixture 的手动 dispatch 上骨架仍绿（启动/资产/备份导入离线用例照跑）。
- **版本记录要求**：fixture 版本常量与 androidTest `AndroidSmokeTest.FIXTURE_VERSION` 两处同步改；
  每个测试类 `@Before` 把 fixture 版本/URL、设备 API、APK 版本写进 instrumentation 日志（logcat tag `VRadioSmoke`）；
  失败报告按 L4 要求逐项在案（报告 + logcat + fixture 日志，见 workflow artifact）。
- **执行分层**：稳定模拟器（GitHub Actions `android-instrumented-draft.yml`，当前 workflow_dispatch/夜间草案，
  首次 dispatch 只验镜像/协议可用性）为 PR/夜间候选；实体设备只做发布前验收——音频焦点让位/恢复、
  Widget 播放/⏮⏭、后台/进程回收恢复快照属发布前设备层用例，不进模拟器门。

## 发布（M5）

- 直装 APK + GitHub Releases（附 hash 置顶、先验后装；D4）。release APK 哨兵 <5MB（R8 忘开/资源误打包会爆线，事故哨兵而非功能预算）。
- 签名：`android/keystore.properties`（gitignored）四键 `storeFile/storePassword/keyAlias/keyPassword`，存在则 release 自动用之，缺省退回 debug 签名（仅本地自测用）。**keystore 生成即双备份（密码管理器 + 离线介质）——丢失 = 无法续签升级**。
- CI（`.github/workflows/android.yml`，path filter `android/**`）出 debug APK artifact；正式 release 在本地签名构建后附 hash 上传。

## 已知坑（安卓侧特有的，Web 侧坑见 AGENTS.md）

- Icecast `ICY 200 OK` 非标状态行 → 播放/探活一律 okhttp（D6），不用 HttpURLConnection 系 DataSource。
- `usesCleartextTraffic=true` 是明知决定（国内流全是 http），接受运营商 QoS/劫持的既有边界。
- 蜻蜓建流 5-10s 慢：连接中指示必须明确，防用户误判卡死。
- 流地址 = 不可信输入：探活按「持续吐字节 ≥ 阈值」验收，不能信状态码/Content-Type（xmcdn 假流）。
- 同步/探活只直连 api.github.com，**不引入 raw.githubusercontent.com**（review Q7/R2）。
- 高刷：MainActivity 只发 `preferredRefreshRate` hint（取该屏 supportedModes 最大值，≤60Hz 屏不设），个别 ROM 的 per-app 强制 60 仍可能压过它——实机不生效先查系统「应用刷新率」类设置，再归因代码。
- 音频卸载（batch1 E5，实验性默认关）：builder 期选项改开关须**重启应用生效**；ENABLED 模式不支持的流自动回退软解；与均衡器互斥（均衡器批次二未做，先留档）。
