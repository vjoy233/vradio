# VRadio R8 规则（M5）：默认规则已覆盖 AndroidX/Compose/Media3 收缩，这里只放实验确认需要的补丁
# okhttp：可选依赖（okio 的扩展点）在收缩期报警属预期
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
