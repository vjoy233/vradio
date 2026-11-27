/* VRadio 发布开关（B3 独立发布单元，plan-expansion-r4 §7）——发布配置不是用户数据：
   默认值随版本发布翻转（核心版本全关、B3 门槛通过后开对应项），不入 radio.*、不进备份。
   开发/验收时可经 localStorage['feat.<名>']='1'|'0' 临时覆盖（内存态，清缓存即回默认）。
   装载顺序硬约束：store → player → logos → radio-data → features → srcorder → quality-store → metadata → listen-stats → app → sync（app 读开关装配 sink/统计/发现入口）。 */
window.FEATURES = (function () {
  const def = {
    // 2026-11-15 发布翻转：B3 双端门槛验收通过 + ui-redesign P6 验收（51 断言）通过，四开关默认开。
    // 回滚 = 对应默认值改回 false 再发一版（各开关独立回滚）；用户单侧退出 localStorage['feat.<名>']='0'。
    metadataV2: true,   // B3-A 元数据 v2 管线（关 = LegacyMetadataSink，曲讯/icy-br/MediaSession/radio.songs 走旧链）
    listenStats: true,  // B3-B 本地收听统计（关 = 不消费统计事件、不 flush sidecar；不清已有数据）
    discovery: true,    // B3-C 本地发现页（关 = 隐藏入口与派生计算；不影响主列表排序）
    discoverySidecar: false, // C3 精选 sidecar：发布门保留，默认不读第三上游
    uiRefresh: true,    // 桌面新版壳总开关（ui-redesign §6.6/P2）：≥1024px 生效为桌面壳，窄窗口与旧紧凑布局不变
  };
  try {
    const o = {};
    for (const k of Object.keys(def)) {
      if (k === 'discoverySidecar') { o[k] = false; continue; } // C3 不接受本地覆盖
      const v = localStorage.getItem('feat.' + k);
      o[k] = v === '1' ? true : v === '0' ? false : def[k];
    }
    return o;
  } catch (_) { return Object.assign({}, def); } // file:// 前异常静默回默认
})();
