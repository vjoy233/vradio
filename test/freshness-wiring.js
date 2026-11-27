// 双端新鲜度关键接线静态回归；不替代 Android 真机 UI 测试。
const assert = require('assert'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const base = 'android/app/src/main/java/io/github/vjoy233/vradio/ui/';
const app = read(base + 'AppRoot.kt'), settings = read(base + 'SettingsScreen.kt'), vm = read(base + 'AppVm.kt');
assert(app.includes('val gate by vm.netGate.collectAsState()'), '网络确认在根页面订阅');
assert(app.includes('onOk = vm::proceedGate, onDismiss = vm::cancelGate'), '根页面确认或取消网络门');
assert(!settings.includes('val gate by vm.netGate.collectAsState()'), '设置页不重复展示确认');
assert(/fun syncFromFreshness\(\)\s*\{\s*freshnessPrompt\.value = false;\s*fullSyncNow\(onDenied\s*=\s*\{\s*openSettings\(focusNetwork\s*=\s*true\)\s*\}\)\s*\}/.test(vm), '提醒关闭后走手动同步策略门，蜂窝拒绝导航网络设置');
assert(/fun fullSyncNow\(onDenied: \(\(\) -> Unit\)\? = null\)[\s\S]*?is NetGate\.Next\.Deny ->\s*\{[\s\S]*?if \(n\.cellularPolicy\) onDenied\?\.invoke\(\)/.test(vm), '同步拒绝分支按蜂窝策略调用回调');
assert(/freshnessPref\.value = Freshness\.parse\(Store\.get\(C\.K_SYNC_FRESHNESS\)\)\s+freshnessPrompt\.value = false/.test(vm), '导入成功刷新偏好');
for (const fn of ['setFreshnessDays', 'disableFreshness', 'dismissFreshness']) {
  const line = vm.split('\n').find(s => s.includes('fun ' + fn + '('));
  assert(line && line.includes('Freshness.parse(Store.get(C.K_SYNC_FRESHNESS))'), fn + ' 写前读最新偏好');
}
console.log('freshness wiring: 根页面网络门与导入刷新静态检查通过');
