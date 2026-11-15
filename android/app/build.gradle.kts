// app 模块：依赖白名单封闭清单（plan-android.md §四/D6 okhttp 唯一破例）
import java.util.Properties
import java.time.Instant
import java.time.OffsetDateTime

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}

android {
  namespace = "io.github.vjoy233.vradio"
  compileSdk = 36
  buildToolsVersion = "36.0.0" // 钉死与已装组件一致（AGP 8.13 默认 35.0.0；显式钉 36 免拉默认件）

  defaultConfig {
    applicationId = "io.github.vjoy233.vradio" // D5 拍板
    minSdk = 26      // D3 拍板（Android 8；Media3 最低 24 留两档余量）
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
  }

  // 签名：keystore.properties 存在则用正式密钥（gitignored，见 README 发布节），否则 release 退回 debug 签名保 CI 可出包
  val ksProp = rootProject.file("keystore.properties")
  val ks = if (ksProp.exists()) Properties().apply { ksProp.inputStream().use { load(it) } } else null
  signingConfigs {
    if (ks != null) create("release") {
      storeFile = rootProject.file(ks.getProperty("storeFile"))
      storePassword = ks.getProperty("storePassword")
      keyAlias = ks.getProperty("keyAlias")
      keyPassword = ks.getProperty("keyPassword")
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = true       // R8 收缩（M5 体积哨兵 <5MB 的前提）
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      // AIbot P2-3：keystore.properties 缺席时回退 debug 签名——unsigned 包装不上；本地/CI 的
      // assembleRelease 直接可用（正式发布仍走 keystore，见 README 发布节）
      signingConfig = if (ks != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
    }
  }

  // lint 纪律 = 单测 + 冒烟（AGENTS 口径，无 lint 配置）；release 默认挂的 lintVital 会解析
  // jaxb/commons-compress 等 lint 自身依赖——镜像瞬时 502 即红脸（CI 实测），关掉去随机性
  lint { checkReleaseBuilds = false }

  buildFeatures {
    compose = true
    buildConfig = true             // 版本号单一来源（设置页「关于」读 BuildConfig.VERSION_NAME，AIbot P3）
  }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
}

dependencies {
  // —— AndroidX Compose（BOM 统一版本；2026.09.00 的 material-ripple 1.12.1 要求 compileSdk 37>AGP 8.13 上限 36，钉 06.01）——
  val composeBom = platform("androidx.compose:compose-bom:2026.06.01")
  implementation(composeBom)
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.activity:activity-compose:1.13.0")
  implementation("androidx.core:core-ktx:1.17.0") // 1.19+ 要 AGP 9.1/compileSdk 37，钉 36 兼容线
  // —— Media3（D1：exoplayer/hls/session；datasource-okhttp 引 okhttp——D6 唯一白名单破例，ICY 200 OK 非标状态行）——
  implementation("androidx.media3:media3-exoplayer:1.11.1")
  implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
  implementation("androidx.media3:media3-session:1.11.1")
  implementation("androidx.media3:media3-datasource-okhttp:1.11.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  // —— 协程（Q3 收编，白名单内）——
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
  // —— 测试（纯 JVM，秒级离线口径对齐 test/smoke.js）——
  testImplementation("junit:junit:4.13.2")
  testImplementation("org.json:json:20250107") // android.jar 里的 org.json 是抛异常桩，纯 JVM 单测须挂真实现
  // 同理（B4）：android.jar 的 org.xmlpull.v1.XmlPullParserFactory 也是抛异常桩——data/PlaylistParser.kt 的
  // XML 解析在单测环境须挂真实现（kxml2 = Android 平台内置的同一解析器，设备运行时用平台实现不进 APK）
  testImplementation("net.sf.kxml:kxml2:2.3.0")
}

// —— 数据文件打包：仓库根 radio.txt/logos.txt（update-sources.js 产出的单一数据源）→ assets，随行写 data-stamp.txt
//    （D7 轻更新判新旧的打包基线 = radio/logos 两文件最近一次 git 提交的较新者——与 LightUpdate.latestIso 同取 max，
//    只看 radio.txt 时 logos 单独晚提交会让首装首查误报「有新版」；无 git 环境退回当前时间）——
val repoRoot = rootDir.parentFile // android/ 的上级 = 仓库根
val genAssetsDir = layout.buildDirectory.dir("generated/radioAssets")

// %cI 可带 +08:00 偏移、Instant.parse 只认 Z 后缀（LightUpdate.iso 同款两道解析）
fun parseIso(s: String): Instant = try { Instant.parse(s) } catch (_: Exception) {
  try { OffsetDateTime.parse(s).toInstant() } catch (_: Exception) { Instant.EPOCH }
}
fun lastIso(path: String): String? = runCatching {
  ProcessBuilder("git", "log", "-1", "--format=%cI", "--", path)
    .directory(repoRoot).start().inputStream.bufferedReader().readText().trim().takeIf { it.isNotEmpty() }
}.getOrNull()

val copyRadioData by tasks.registering {
  outputs.upToDateWhen { false } // 数据小且常变，每次构建都重拷（秒级）
  doLast {
    val out = genAssetsDir.get().asFile.apply { mkdirs() }
    listOf("radio.txt", "logos.txt").forEach { f ->
      val src = File(repoRoot, f)
      if (!src.exists()) throw GradleException("缺少仓库根数据文件 $f——先在仓库根跑 npm run sync")
      src.copyTo(File(out, f), overwrite = true)
    }
    // B2 radio-meta.json（来源追踪旁车，plan-expansion-r4 §6.3）：仓库根暂无该文件时**跳过不报错**
    // （生成在 Web 同步侧，落地后自然随包带上；消费端 RadioMeta.parse 缺件按空对象兜底）。
    // data-stamp 仍只看 radio/logos 两文件提交——meta 单独晚提交不触发 D7 误报「有新版」。
    File(repoRoot, "radio-meta.json").takeIf { it.isFile }?.copyTo(File(out, "radio-meta.json"), overwrite = true)
    val stamp = listOf("radio.txt", "logos.txt").mapNotNull(::lastIso)
      .maxByOrNull { parseIso(it) } ?: Instant.now().toString()
    File(out, "data-stamp.txt").writeText(stamp)
  }
}

android { sourceSets.getByName("main").assets.srcDir(genAssetsDir) }
tasks.named("preBuild") { dependsOn(copyRadioData) }

// —— 契约资源接线（B0，plan-expansion-r4 §4.2）：仓库根 contracts/（radio-keys.json + fixtures/）挂进 test
//    resources，JVM 单测经 classLoader 读取——Web/Android 双端消费同一份契约文件（漏改任一侧被 ContractTest 拦截）——
android { sourceSets.getByName("test").resources.srcDir(File(repoRoot, "contracts")) }
