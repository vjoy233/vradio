// 契约测试（B0，plan-expansion-r4 §4.2）：读 contracts/radio-keys.json，比对三侧键白名单——
// store.js 的 KEYS、server.js 的 STORE_KEYS、Android Consts.kt 的 C.KEYS（常量声明与引用一致性另测，
// 比较不受声明顺序影响）。另校验：排除键不入白名单、fixtures 可解析且只含白名单键、
// radio.cfg v2 迁移入口与备份 v2 兼容入口存在。零依赖离线，npm test 随跑。
const fs = require('fs'), assert = require('assert');
const spec = JSON.parse(fs.readFileSync('contracts/radio-keys.json', 'utf8'));

function readKeys(file, re) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(re);
  assert(m, `未找到键声明：${file}`);
  return [...m[1].matchAll(/['"](radio\.[A-Za-z0-9]+)['"]/g)].map(x => x[1]);
}

const expected = Object.keys(spec.keys).sort();
const web = readKeys('store.js', /KEYS:\s*\[([\s\S]*?)\]/);
const server = readKeys('server.js', /STORE_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);

function readAndroidKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const declared = [...text.matchAll(/^\s*const\s+val\s+K_\w+\s*=\s*"(radio\.[A-Za-z0-9]+)"\s*$/gm)]
    .map(m => m[1]);
  const block = text.match(/KEYS\s*=\s*listOf\(([^)]*)\)/s);
  assert(block, `未找到 Android C.KEYS：${file}`);
  const refs = [...block[1].matchAll(/\b(K_\w+)\b/g)].map(m => m[1]);
  const byName = new Map([...text.matchAll(/^\s*const\s+val\s+(K_\w+)\s*=\s*"(radio\.[A-Za-z0-9]+)"\s*$/gm)]
    .map(m => [m[1], m[2]]));
  assert(refs.length > 0, 'Android C.KEYS 为空');
  const sort = xs => [...new Set(xs)].sort();
  assert.deepStrictEqual(sort(refs.map(k => byName.get(k))), sort(declared), 'Android 常量声明与 C.KEYS 不一致');
  return declared;
}

const android = readAndroidKeys('android/app/src/main/java/io/github/vjoy233/vradio/consts/Consts.kt');

for (const [name, got] of Object.entries({ web, server, android })) {
  assert.deepStrictEqual([...new Set(got)].sort(), expected, `${name} 键集合漂移`);
}
for (const k of spec.excluded) {
  assert.ok(!web.includes(k) && !server.includes(k) && !android.includes(k), `排除键 ${k} 误入白名单`);
}

// 备份覆盖面：v2/v3 黄金样本的 data 键必须全在白名单内（backup:false 的键不得出现）
for (const f of ['backup-v2.json', 'backup-v3.json']) {
  const j = JSON.parse(fs.readFileSync(`contracts/fixtures/${f}`, 'utf8'));
  const ver = j.version || j.v;
  assert.ok(j.data && typeof j.data === 'object', `${f} 缺 data`);
  for (const k of Object.keys(j.data)) {
    assert.ok(spec.keys[k], `${f} 出现非契约键 ${k}`);
    assert.ok(spec.keys[k].backup, `${f} 出现不可备份键 ${k}`);
    assert.strictEqual(typeof j.data[k], 'string', `${f} 的 ${k} 值须为字符串`);
  }
  assert.ok(Array.isArray(j.my || j.myRadio), `${f} 缺个人电台行数组`);
}
{
  const v3 = JSON.parse(fs.readFileSync('contracts/fixtures/backup-v3.json', 'utf8'));
  assert.strictEqual(v3.format, 'vradio-backup');
  assert.strictEqual(v3.version, 3);
  assert.ok(v3.extensions && typeof v3.extensions === 'object', 'v3 缺 extensions（默认空对象）');
  assert.ok(Array.isArray(v3.myRadio), 'v3 缺 myRadio 数组');
}

// 电台配置契约：radio.cfg v2 迁移入口与新增三字段清洗入口存在（实现漂移先在这里红）
{
  const appjs = fs.readFileSync('app.js', 'utf8');
  assert.ok(/migrateCfgV1/.test(appjs), 'app.js 缺 migrateCfgV1 迁移入口');
  for (const f of ['srcManualOrder', 'srcDisabled', 'srcLabels'])
    assert.ok(new RegExp(`\\.${f}\\s*=`).test(appjs), `app.js normCfg 未清洗 ${f}`);
  const cfgkt = fs.readFileSync('android/app/src/main/java/io/github/vjoy233/vradio/data/Cfg.kt', 'utf8');
  for (const f of ['srcManualOrder', 'srcDisabled', 'srcLabels'])
    assert.ok(cfgkt.includes(`"${f}"`), 'Android CfgCodec 未解析 ' + f);
}

// 元数据/诊断黄金样本形状冻结（B3/B1 消费；此处只验形态）
{
  const mg = JSON.parse(fs.readFileSync('contracts/fixtures/metadata-golden.json', 'utf8'));
  assert.ok(Array.isArray(mg.cases) && mg.cases.length >= 5, 'metadata-golden 样本不足');
  for (const c of mg.cases) {
    for (const k of ['title', 'artist', 'track', 'program', 'bitrateKbps', 'source', 'confidence', 'at'])
      assert.ok(k in c.out, `golden「${c.name}」out 缺 ${k}`);
    assert.strictEqual(c.out.confidence === 'parsed', !!c.out.artist, `golden「${c.name}」confidence 与 artist 拆分不一致`);
  }
  const dr = JSON.parse(fs.readFileSync('contracts/fixtures/diagnostic-results.json', 'utf8'));
  const codes = JSON.parse(fs.readFileSync('contracts/source-diagnostic.json', 'utf8')).codes;
  assert.ok(Array.isArray(dr.results) && dr.results.length >= 3, 'diagnostic-results 样本不足');
  for (const r of dr.results) {
    for (const k of ['url', 'ok', 'code', 'hls', 'mode', 'httpStatus', 'contentType', 'bytes', 'latencyMs', 'why', 'checkedAt'])
      assert.ok(k in r, `diagnostic 样本缺 ${k}`);
    assert.ok(codes.includes(r.code), `未知 code：${r.code}`);
  }
}

// 双端质量聚合黄金样本形状冻结（AIbot P1-2：round-trip 驱动在 test/quality-store.js 与 Android ContractTest，
// 此处只验形态——events 覆盖契约 opEvent 必填枚举、expected 覆盖 aggregate 全字段、files 节双包装描述在位）
{
  const qc = JSON.parse(fs.readFileSync('contracts/quality-summary.json', 'utf8'));
  assert.ok(qc.files && qc.files.web.includes('{ v:1, rev') && qc.files.android.includes('{ v:1, stations'),
    'quality-summary 缺 files 双包装形态描述（Web {v,rev,ops,data} vs Android {v,stations}）');
  // 409 机器可读 code 契约点（AIbot PR#26 复核 P2）：api 描述必须点名三类 code（行为断言在 test/quality.js 三处 409）
  assert.ok(qc.api && qc.api['POST /api/quality'] && ['schema', 'batch-limit', 'too-large']
    .every(c => qc.api['POST /api/quality'].includes('code=' + c)),
    'quality-summary POST api 描述缺三类 409 code（schema/batch-limit/too-large）枚举点名');
  const fx = JSON.parse(fs.readFileSync('contracts/fixtures/quality-aggregate.json', 'utf8'));
  assert.ok(Array.isArray(fx.events) && fx.events.length >= 5, 'quality-aggregate 样本不足');
  const kinds = new Set(['diagnostic', 'playback']), modes = new Set(['direct', 'hls', 'proxy']);
  for (const e of fx.events) {
    for (const k of ['kind', 'trigger', 'sourceUrl', 'ok', 'latencyMs', 'bytes', 'mode', 'at'])
      assert.ok(k in e, `quality-aggregate 事件缺 ${k}`);
    assert.ok(kinds.has(e.kind) && modes.has(e.mode), `quality-aggregate 事件枚举越界：${e.kind}/${e.mode}`);
  }
  for (const k of Object.keys(qc.aggregate))
    assert.ok(k in fx.expected, `quality-aggregate expected 缺聚合字段 ${k}`);
}

// 收听统计 sidecar 契约形状冻结（B3，AIbot 复核 P1/P2：rev 条件获取 + 409 机器可读 code + 落盘确认模型；
// 行为驱动在 test/listen-stats.js 与 Android ListenStatsTest/ContractTest 双端点名——此处只验契约描述在位）
{
  const lc = JSON.parse(fs.readFileSync('contracts/listen-stats-summary.json', 'utf8'));
  assert.ok(lc.files.web.includes('{ v:1, rev') && lc.files.android.includes('{ v:1, days'),
    'listen-stats-summary 缺 files 双包装形态描述（Web {v,rev,ops,days} vs Android {v,days}）');
  assert.ok(lc.files.shared.includes('YYYY-MM-DD'), 'listen-stats-summary 缺 days 共享形态/日期键规则描述');
  assert.ok(lc.files.writeFailure.includes('下次 flush'), 'listen-stats-summary 缺写失败保留增量重试语义');
  // AIbot 三轮 P1：Android pending 启动恢复语义在位（Web 侧无 pending 文件消费——服务端 op 日志已覆盖同语义，
  // 此处只点名契约描述，行为测试在 Android ListenStatsTest 重启恢复用例）
  assert.ok(lc.files.android.includes('listen-stats.pending.json') && lc.files.writeFailure.includes('不双计'),
    'listen-stats-summary 缺 Android 写失败 pending 持久化/启动恢复语义（AIbot 三轮 P1）');
  for (const k of ['id', 'day', 'ms', 'sess'])
    assert.ok(k in lc.opEvent, `listen-stats-summary opEvent 缺 ${k}`);
  assert.ok(lc.api['GET /api/listenstats?rev=<optional>'].includes('notModified'),
    'listen-stats-summary 缺 GET ?rev= 条件获取语义（AIbot 复核 P2）');
  const post = lc.api['POST /api/listenstats'];
  assert.ok(post.includes("'schema'") && post.includes("'batch-limit'"),
    'listen-stats-summary 缺 409 机器可读 code 分类语义（AIbot 复核 P1）');
  assert.ok(lc.tests.web.includes('test/listen-stats.js') && lc.tests.android.includes('ListenStatsTest')
    && lc.tests.contract.includes('ContractTest'), 'listen-stats-summary 缺双端测试点名');
}

console.log(`contract keys OK: ${expected.length}（web/server/android 三侧一致；excluded ${spec.excluded.length}）`);
