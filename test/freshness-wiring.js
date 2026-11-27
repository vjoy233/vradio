// 双端新鲜度关键接线静态回归；不替代 Android 真机 UI 测试。
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const base = 'android/app/src/main/java/io/github/vjoy233/vradio/ui/';
const app = read(base + 'AppRoot.kt'), settings = read(base + 'SettingsScreen.kt'), vm = read(base + 'AppVm.kt');
assert(app.includes('val gate by vm.netGate.collectAsState()'), '网络确认在根页面订阅');
assert(app.includes('onOk = vm::proceedGate, onDismiss = vm::cancelGate'), '根页面确认或取消网络门');
assert(!settings.includes('val gate by vm.netGate.collectAsState()'), '设置页不重复展示确认');
assert(vm.includes('fun syncFromFreshness() { freshnessPrompt.value = false; fullSyncNow() }'), '提醒走手动同步策略门');
assert(/freshnessPref\.value = Freshness\.parse\(Store\.get\(C\.K_SYNC_FRESHNESS\)\)\s+freshnessPrompt\.value = false/.test(vm), '导入成功刷新偏好');
for (const fn of ['setFreshnessDays', 'disableFreshness', 'dismissFreshness']) {
  const line = vm.split('\n').find(s => s.includes('fun ' + fn + '('));
  assert(line && line.includes('Freshness.parse(Store.get(C.K_SYNC_FRESHNESS))'), fn + ' 写前读最新偏好');
}
console.log('freshness wiring: 根页面网络门与导入刷新静态检查通过');
