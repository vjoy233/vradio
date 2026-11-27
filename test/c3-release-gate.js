// C3 源码硬门：本地覆盖及运行时伪造开关都不可启动候选读取。
const assert = require('assert'), fs = require('fs'), vm = require('vm');
const features = fs.readFileSync(require.resolve('../features.js'), 'utf8');
const box = {window:{}, localStorage:{getItem:() => '1'}}; vm.runInNewContext(features, box);
assert.strictEqual(box.window.FEATURES.discoverySidecar, false);
const {App} = require('../app');
const body = {innerHTML:''}, els = {discovery:{hidden:true},discBody:body,discClose:{focus(){}},status:{}};
global.document = {activeElement:null,getElementById:id => els[id]};
global.FEATURES = {discoverySidecar:true}; let calls = 0;
global.window = {DiscoverySidecar:{loadSnapshot:() => { calls++; return Promise.resolve([{name:'x'}]); }}};
global.DiscoverySidecar = global.window.DiscoverySidecar;
App.metaCache = {}; App.renderDiscovery = () => {}; App.renderDiscoverySidecar = () => { throw Error('硬门未生效'); };
App.openDiscovery().then(() => { assert.strictEqual(calls,0); console.log('C3 release gate: ok'); }).catch(e => { console.error(e); process.exitCode=1; });
