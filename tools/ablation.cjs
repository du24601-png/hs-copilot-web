// tools/ablation.cjs —— 检索链路消融实验
// 目的：回答「加权合并 / 分数集中度 / 第二轮 是否必要」
// 做法：先跑一遍真实服务拿到 AI 规划结果，再离线用同一份规划重算各个简化变体，避免重复烧 LLM 额度。
// 用法: node tools/ablation.cjs
const { spawn } = require('node:child_process');
const path = require('path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const PORT = 7199;
const S = require(path.join(ROOT, 'server.js'));

// 期望品目均已对照 hs_copilot.db 内真实品名核实
const EXPECT = {
  '不锈钢真空保温杯 500ml': '9617',
  '实木蓝牙音箱': '8518',
  '电动牙刷': '8509',
  '铝合金 iPad 触控笔': '9608',
  '纯棉针织男式T恤': '6109',
  '智能手机': '8517',
  '笔记本电脑': '8471',
  '玻璃高脚红酒杯': '7013',
  '婴幼儿配方奶粉': '1901',
  '天然蜂蜜': '0409',
  '山地自行车': '8712',
  '陶瓷马桶': '6910',
  '一次性医用外科口罩': '6307',
  '小轿车用新橡胶轮胎': '4011',
  '女式真皮手提包': '4202'
};
const QUERIES = Object.keys(EXPECT);

const db = new DatabaseSync(path.join(ROOT, 'hs_copilot.db'), { readOnly: true });

/* ---- 复刻 server.js 内部两个未导出的检索函数 ---- */
const codesFor = text => text
  ? S.retrieveCandidates(String(text), [], { useHeadBoost: false, suffixOnly: true }).map(c => c.code)
  : [];

function codesInChapter(chapter, word) {
  const ch = String(chapter).replace(/\D/g, '').slice(0, 2);
  if (ch.length !== 2) return [];
  if (word) {
    const rows = db.prepare('SELECT code FROM hs_code WHERE code LIKE ? AND name LIKE ? LIMIT 30')
      .all(ch + '%', '%' + word + '%');
    if (rows.length) return rows.map(r => r.code);
  }
  return db.prepare('SELECT code FROM hs_code WHERE code LIKE ? LIMIT 12').all(ch + '%').map(r => r.code);
}

const PLAN_WEIGHT = { base: 2, core: 3, alt: 2.5, chapter: 1.5, structure: 2, material: 0.5, param: 1 };
const FLAT_WEIGHT = { base: 1, core: 1, alt: 1, chapter: 1, structure: 1, material: 1, param: 1 };

const listOf = (plan, lookupChapterCodes) => ({
  core: codesFor(plan.core.word),
  alt: plan.core.alt.map(codesFor),
  chapter: plan.core.chapters.map(c => lookupChapterCodes(c, plan.core.word || plan.structure.word)),
  structure: codesFor(plan.structure.word),
  material: codesFor(plan.material.word),
  param: plan.params.filter(p => p.affectsCode && p.value).map(p => codesFor(p.value))
});

function roundRobin(lists, limit = 16, perHeading = 6) {
  const picked = [], seen = new Set(), cnt = new Map();
  const maxLen = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < maxLen && picked.length < limit; i++) {
    for (const l of lists) {
      const code = l[i];
      if (!code || seen.has(code) || picked.length >= limit) continue;
      const h = code.slice(0, 4);
      if ((cnt.get(h) || 0) >= perHeading) continue;
      seen.add(code);
      cnt.set(h, (cnt.get(h) || 0) + 1);
      picked.push(code);
    }
  }
  return picked;
}

// 复刻 candidatesFor，用开关控制各个机制
function runVariant(rec, { weights, mode }) {
  const { plan, baseCodes } = rec;
  if (mode === 'roundrobin') {
    const l = listOf(plan, codesInChapter);
    return roundRobin([l.core, baseCodes, ...l.alt, l.structure, ...l.chapter, l.material, ...l.param]);
  }
  return S.mergeCandidateCodes(plan, baseCodes, codesFor, codesInChapter, weights).picked;
}

const VARIANTS = {
  'V0 现行（加权合并）': { weights: PLAN_WEIGHT },
  'V1 去掉层间权重': { weights: FLAT_WEIGHT },
  'V2 极简：交错合并不打分': { mode: 'roundrobin' }
};

/* ---- 采集：起服务 → 逐条探测 → 抓 [plan] 日志 ---- */
function post(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/classify', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseLogs(chunk) {
  const out = { plan: null };
  const p1 = chunk.match(/\[plan\] (\{[\s\S]*?\}) \d+ms/);
  if (p1) { try { out.plan = JSON.parse(p1[1]); } catch {} }
  return out;
}

(async () => {
  const child = spawn(process.execPath, ['server.js', '--port', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  child.stdout.on('data', c => { buf += c; });
  child.stderr.on('data', c => { buf += c; });

  for (let i = 0; i < 40; i++) { if (await health(PORT)) break; await sleep(500); }
  if (!await health(PORT)) { console.error('服务未能启动'); child.kill(); process.exit(1); }
  console.log('服务已就绪，开始采集 ' + QUERIES.length + ' 条查询…\n');

  const records = [];
  for (const q of QUERIES) {
    const mark = buf.length;
    let d = null;
    try { d = await post(PORT, { query: q }); }
    catch (e) { console.log('[跳过] ' + q + ' -> ' + e.message); continue; }
    const chunk = buf.slice(mark);
    const { plan } = parseLogs(chunk);
    if (!plan) { console.log('[跳过] ' + q + ' -> 未抓到规划结果'); continue; }
    const baseCodes = S.retrieveCandidates(q).map(c => c.code);
    records.push({ q, plan, baseCodes, live: (d.candidates || []).map(c => c.code) });
    console.log('  ✓ ' + q + '  置信度=' + plan.confidence);
  }
  child.kill();
  await sleep(300);

  console.log('\n采集完成：' + records.length + ' 条\n');

  /* ---- 离线重算各变体 ---- */
  const score = codes => {
    const res = {};
    for (const [name, opt] of Object.entries(VARIANTS)) {
      let top3 = 0, hit = 0, rrank = 0, n = 0;
      for (const rec of records) {
        const want = EXPECT[rec.q];
        const picked = runVariant(rec, opt);
        const idx = picked.findIndex(c => c.startsWith(want));
        n++;
        if (idx >= 0) { hit++; rrank += 1 / (idx + 1); if (idx < 3) top3++; }
      }
      res[name] = { top3, hit, n, mrr: n ? rrank / n : 0 };
    }
    return res;
  };

  const results = score();
  // 线上真实返回（含 P1，作为对照基准）
  let liveTop3 = 0, liveHit = 0;
  for (const rec of records) {
    const idx = rec.live.findIndex(c => c.startsWith(EXPECT[rec.q]));
    if (idx >= 0) { liveHit++; if (idx < 3) liveTop3++; }
  }

  console.log('期望品目为 4 位税则品目；"进池"=出现在 ≤16 条候选里，"前3"=排进候选前 3 位\n');
  console.log('变体'.padEnd(30) + '进池'.padEnd(10) + '前3'.padEnd(10) + 'MRR');
  console.log('-'.repeat(60));
  console.log(('线上真实返回（对照）').padEnd(26) + (liveHit + '/' + records.length).padEnd(10) + (liveTop3 + '/' + records.length).padEnd(10) + '-');
  for (const [name, r] of Object.entries(results)) {
    console.log(name.padEnd(26) + (r.hit + '/' + r.n).padEnd(10) + (r.top3 + '/' + r.n).padEnd(10) + r.mrr.toFixed(3));
  }

  console.log('\n逐条明细（前 3 位品目，✔=命中期望）：');
  for (const rec of records) {
    const want = EXPECT[rec.q];
    const line = ['  ' + rec.q.padEnd(22) + '期望 ' + want];
    for (const [name, opt] of Object.entries(VARIANTS)) {
      const picked = runVariant(rec, opt);
      const idx = picked.findIndex(c => c.startsWith(want));
      line.push(name.split(' ')[0] + ':' + (idx >= 0 ? '#' + (idx + 1) : '×'));
    }
    console.log(line.join('  '));
  }
})();
