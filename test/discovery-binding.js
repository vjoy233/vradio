// 本地 meta 同批绑定及异步换代：只用内存 fixture，不联网。
const assert = require('assert'), crypto = require('crypto');
const { App } = require('../app');
global.location = {protocol:'http:'}; global.crypto = crypto.webcrypto;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const radio = 'X,#genre#\r\nA,http://a/1\r\n';
const raw = JSON.stringify({v:1,stations:{'http://a/1':{sources:[{url:'http://a/1',upstream:'gao'}]}}});
let manifest = JSON.stringify({files:[{path:'radio.txt',sha256:hash(radio)},{path:'radio-meta.json',sha256:hash(raw)}]});
global.fetch = async p => ({ok:true,text:async () => p.startsWith('sync-manifest') ? manifest : raw});
(async () => {
  assert.ok(await App.loadMeta(radio));
  assert.strictEqual(await App.loadMeta(radio + 'changed'), null);
  manifest = JSON.stringify({files:[{path:'radio.txt',sha256:hash(radio)},{path:'radio-meta.json',sha256:hash('old')}]});
  assert.strictEqual(await App.loadMeta(radio), null);
  // 新装配立即清除旧缓存，正在请求的旧 meta 不能越世代提交。
  const orig = {loadMeta:App.loadMeta,renderDiscovery:App.renderDiscovery,applyCfg:App.applyCfg,rebind:App.rebind,render:App.render,showLast:App.showLast};
  let resolve; App.loadMeta = () => new Promise(r => { resolve = r; });
  App.renderDiscovery = () => {}; App.applyCfg = () => {}; App.rebind = () => {}; App.render = () => {}; App.showLast = () => {};
  const els = {discovery:{hidden:true},discBody:{innerHTML:''},discClose:{focus(){}}};
  global.document = {activeElement:null,getElementById:id => els[id]}; global.Player = {station:null};
  App.metaMain = radio; App.metaCache = null; App.state.stations = [];
  const pending = App.openDiscovery();
  App.applySources([], []);
  assert.strictEqual(App.metaCache, null); assert.strictEqual(App.metaMain, null);
  resolve({v:1,stations:{old:{}}}); await pending;
  assert.strictEqual(App.metaCache, null);
  Object.assign(App, orig);
  console.log('发现 meta 同批绑定、混态及异步换代通过');
})().catch(e => { console.error(e); process.exitCode = 1; });
