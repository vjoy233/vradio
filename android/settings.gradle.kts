// VRadio 安卓端工程配置 —— 国内镜像优先、官方源兜底（M-1 环境闸口拍板，见 android/README.md 环境节）。
// review 期两次 CI 红脸实录：阿里云镜像 502 时 Gradle 会把该仓库**整轮禁用**，同轮其余工件全部连带失败——
// CI（GitHub Actions 自动注入 CI=true）改直连官方源（runner 在海外，官方源快且稳）；本地仍阿里云先行（境内直连官方源不可达）。
val onCi = System.getenv("CI") != null

pluginManagement {
  repositories {
    if (!onCi) {
      maven("https://maven.aliyun.com/repository/gradle-plugin") // 插件镜像先行
      maven("https://maven.aliyun.com/repository/google")
      maven("https://maven.aliyun.com/repository/central")
    }
    google()            // 官方兜底（镜像缺件/海外环境/CI）
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS) // 仓库只在此处声明，防模块私加
  repositories {
    if (!onCi) {
      maven("https://maven.aliyun.com/repository/google")
      maven("https://maven.aliyun.com/repository/central")
    }
    google()
    mavenCentral()
  }
}
rootProject.name = "vradio"
include(":app")
