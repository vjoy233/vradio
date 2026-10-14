// 根构建脚本：仅声明插件版本（封闭清单制——新增依赖一律先议事，plan-android.md §四）
plugins {
  id("com.android.application") version "8.13.2" apply false
  id("org.jetbrains.kotlin.android") version "2.2.21" apply false
  id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
}
