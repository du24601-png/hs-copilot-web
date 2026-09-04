// 简单验证:只跑优化前失败的5个疑难案例(001/005/018/019/020),对比"终选规则聚焦"优化前后。
// 模拟真实用户(追问用商品事实回答)、判例开启(HS_RULINGS=1)。串行5例,输出前后对比。
process.env.HS_RULINGS = '1';
process.env.HS_DEBUG = '1';
process.env.PORT = '0';
const path = require('node:path');
const { once } = require('node:events');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..', '..');
const server = require(path.join(root, 'server.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'real-products-noisy-20.json'), 'utf8'));
const TARGET = ['real-001', 'real-005', 'real-018', 'real-019', 'real-020'];
const BEFORE = { 'real-001': '0904210000', 'real-005': '8517795000', 'real-018': '7007190000', 'real-019': '7020009990', 'real-020': '9018909919' };
function factAnswer(q, d) { return q ? [{ attr: String(q.attr || '关键确认').slice(0, 12), answer: '补充商品事实', freeText: String(d).slice(0, 200) }] : []; }
async function post(baseUrl, route, body) {
  const r = await fetch(baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const p = await r.json(); if (!r.ok) throw new Error(p.error || route + ' HTTP ' + r.status); return p;
}
async function runCase(item, baseUrl) {
  const query = String(item.description);
  const p1 = await post(baseUrl, '/api/classify', { query });
  let p2 = null, answers = [];
  if (!p1.refuse) { answers = factAnswer(p1.questions && p1.questions[0], query); p2 = await post(baseUrl, '/api/decide', { query, knownAttrs: p1.knownAttrs || [], answers }); }
  const finalCode = p2 && p2.selectedCode ? String(p2.selectedCode) : null;
  const rulings = (p2 && p2.stats && p2.stats.rulings) || (p1.stats && p1.stats.rulings) || {};
  return { finalCode, correct: finalCode === item.expectedCode, asked: !!(p1.questions && p1.questions.length), caseHits: (rulings.retrievedCaseIds || []).length, addedCodes: (rulings.addedCodes || []).length, legalRefs: (p2 && p2.legalReferences) || [], codeBasis: (p2 && p2.codeBasis) || [] };
}
(async () => {
  const listener = server.startServer();
  await once(listener, 'listening');
  const baseUrl = 'http://127.0.0.1:' + listener.address().port;
  console.log('\n>>> 优化后重跑5个此前失败案例(模拟真实用户·判例开启)\n');
  let improved = 0;
  for (const id of TARGET) {
    const item = fixture.cases.find(c => c.id === id);
    try {
      const r = await runCase(item, baseUrl);
      const tag = r.correct ? '✓ 修正' : (r.finalCode === BEFORE[id] ? '✗ 未变' : '△ 变了仍错');
      if (r.correct) improved++;
      console.log(tag + ' ' + id + ' ' + item.productName);
      console.log('    期望 ' + item.expectedCode + ' | 优化前 ' + BEFORE[id] + ' → 优化后 ' + (r.finalCode || '无'));
      console.log('    追问' + (r.asked ? '是' : '否') + ' | 判例' + r.caseHits + '命中/补' + r.addedCodes + '码 | 终选规则引用' + r.legalRefs.length + '条 | 归类依据' + r.codeBasis.length + '条');
    } catch (e) {
      console.log('✗ ' + id + ' 错误: ' + e.message);
    }
  }
  console.log('\n========== 5例中修正 ' + improved + ' 个 ==========');
  await new Promise(res => listener.close(res));
  process.exit(0);
})();
