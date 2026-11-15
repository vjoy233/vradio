/* VRadio 发布开关（B3 独立发布单元，plan-expansion-r4 §7）——发布配置不是用户数据：
   默认值随版本发布翻转（核心版本全关、B3 门槛通过后开对应项），不入 radio.*、不进备份。
   开发/验收时可经 localStorage['feat.<名>']='1'|'0' 临时覆盖（内存态，清缓存即回默认）。
   装载顺序硬约束：store → player → logos → radio-data → features → srcorder → quality-store → metadata → listen-stats → app → sync（app 读开关装配 sink/统计/发现入口）。 */
window.FEATURES = (function () {
  const def = {
    metadataV2: false,  // B3-A 元数据 v2 管线（关 = LegacyMetadataSink，现状曲讯/icy-br/MediaSession/radio.songs 不回归）
    listenStats: false, // B3-B 本地收听统计（关 = 不消费统计事件、不 flush sidecar；不清已有数据）
    discovery: false,   // B3-C 本地发现页（关 = 隐藏入口与派生计算；不影响主列表排序）
    uiRefresh: false,   // 桌面新版壳总开关（ui-redesign §6.6/P2）：默认关 = 页面与紧凑布局完全一致；
                        // 开发开启 = localStorage['feat.uiRefresh']='1'（≥1024px 时生效为桌面壳）
  };
  try {
    const o = {};
    for (const k of Object.keys(def)) {
      const v = localStorage.getItem('feat.' + k);
      o[k] = v === '1' ? true : v === '0' ? false : def[k];
    }
    return o;
  } catch (_) { return Object.assign({}, def); } // file:// 前异常静默回默认
})();
