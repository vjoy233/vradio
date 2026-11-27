'use strict';
// 即使开发开关打开、内存存在候选，未建立可信发布链时也不请求、不展示、不加入。
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const end = source.match(/\nif \(typeof document !== 'undefined'\) App\.boot\(\);[\s\S]*$/);
assert(end);
const elements = {discovery:{hidden:true},discBody:{innerHTML:''},discClose:{focus(){}},status:{textContent:''}};
let fetches = 0, renders = 0;
const sandbox = {console, setTimeout, clearTimeout, document:{activeElement:null,getElementById:id=>elements[id]}, FEATURES:{discoverySidecar:true}, DiscoverySidecar:{loadSnapshot:async()=>{fetches++; return [{name:'x',url:'https://example.com'}];}}, fetch:()=>{fetches++;}, window:{}};
sandbox.window.DiscoverySidecar = sandbox.DiscoverySidecar;
vm.createContext(sandbox);
vm.runInContext(source.slice(0,end.index)+'\nthis.App=App;',sandbox);
sandbox.App.metaCache = {};
sandbox.App.discoverySidecar = [{name:'x',url:'https://example.com'}];
sandbox.App.renderDiscovery = () => {};
sandbox.App.renderDiscoverySidecar = () => { renders++; };
sandbox.App.openDiscovery().then(()=>{
  assert.strictEqual(fetches,0); assert.strictEqual(renders,0);
  console.log('c3 fail-closed: enabled flag and cached candidates cannot bypass release gate');
}).catch(e=>{console.error(e); process.exitCode=1;});
