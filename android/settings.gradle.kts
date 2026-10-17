// VRadio 安卓端工程配置 —— 国内镜像优先、官方源兜底（M-1 环境闸口拍板，见 android/README.md 环境节）
pluginManagement {
  repositories {
    maven("https://maven.aliyun.com/repository/gradle-plugin") // 插件镜像先行
    maven("https://maven.aliyun.com/repository/google")
    maven("https://maven.aliyun.com/repository/central")
    google()            // 官方兜底（镜像缺件/海外环境）
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS) // 仓库只在此处声明，防模块私加
  repositories {
    maven("https://maven.aliyun.com/repository/google")
    maven("https://maven.aliyun.com/repository/central")
    google()
    mavenCentral()
  }
}
rootProject.name = "vradio"
include(":app")
