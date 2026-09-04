// 模拟真实用户走完整流程跑疑难20例:classify →(系统追问则用商品事实回答)→ decide,
// 看最终10位码是否命中标准答案。开启判例(HS_RULINGS=1),验证判例检索改进在真实交互下的效果。
// 会真实调用 LLM(每例约3次),并发2。结果保存 JSON 并打印逐例+汇总。
process.env.HS_RULINGS = '1';
process.env.HS_DEBUG = '1';
process.env.PORT = '0';
const path = require('node:path');
const fs = require('node:fs');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..', '..');
const server = require(path.join(root, 'server.js'));
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fixtures', 'real-products-noisy-20.json'), 'utf8'));

// 模拟真实用户:遇到追问,用商品描述里的客观事实回答(截断200字),而非空答案终选
function factAnswer(question, description) {
  return question ? [{ attr: String(question.attr || '关键确认').slice(0, 12), answer: '补充商品事实', freeText: String(description).slice(0, 200) }] : [];
}
async function post(baseUrl, route, body, timeoutMs = 120000) {
  const r = await fetch(baseUrl + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const t = await r.text();
  let p; try { p = JSON.parse(t); } catch { throw new Error(route + ' 返回非JSON'); }
  if (!r.ok) throw new Error(p.error || route + ' HTTP ' + r.status);
  return p;
}
const corpusIds = new Set();
async function runCase(item, baseUrl) {
  const t0 = performance.now();
  const query = String(item.description);
  const covered = item.officialDecisionId ? corpusIds.has(item.officialDecisionId) : null;
  try {
    const p1 = await post(baseUrl, '/api/classify', { query });
    let p2 = null, answers = [];
    if (!p1.refuse) {
      answers = factAnswer(p1.questions && p1.questions[0], query);   // 模拟真实用户回答追问
      p2 = await post(baseUrl, '/api/decide', { query, knownAttrs: p1.knownAttrs || [], answers });
    }
    const finalCode = p2 && p2.selectedCode ? String(p2.selectedCode) : null;
    const refused = !!p1.refuse || !!(p2 && p2.refuse) || !finalCode;
    const rulings = (p2 && p2.stats && p2.stats.rulings) || (p1.stats && p1.stats.rulings) || {};
    const pool = (p1.stats && p1.stats.poolCodes) || [];
    return {
      id: item.id, productName: item.productName, expectedCode: item.expectedCode, finalCode,
      correct: !refused && finalCode === item.expectedCode, status: refused ? 'refused' : 'decided',
      asked: !!(p1.questions && p1.questions.length), answered: answers.length, coveredByCorpus: covered,
      caseHits: rulings.retrievedCaseIds || [], addedCodes: rulings.addedCodes || [],
      caseStatus: ((p2 && p2.caseKnowledgeStatus) || p1.caseKnowledgeStatus || {}).status,
      poolSize: pool.length, hs10Hit: pool.includes(item.expectedCode),
      degraded: !!p1.degraded || !!(p2 && p2.degraded),
      llmCalls: ((p1.stats && p1.stats.llmCalls) || 0) + ((p2 && p2.stats && p2.stats.llmCalls) || 0),
      latencyMs: Math.round(performance.now() - t0)
    };
  } catch (e) {
    return { id: item.id, productName: item.productName, expectedCode: item.expectedCode, finalCode: null, correct: false, status: 'error', coveredByCorpus: covered, detail: String(e.message || e), latencyMs: Math.round(performance.now() - t0) };
  }
}

(async () => {
  const db = new DatabaseSync(path.join(root, 'hs_copilot.db'), { readOnly: true });
  for (const r of db.prepare('SELECT decision_no FROM ruling_case').all()) corpusIds.add(r.decision_no);
  db.close();

  const listener = server.startServer();
  await once(listener, 'listening');
  const baseUrl = 'http://127.0.0.1:' + listener.address().port;
  console.log('\n>>> 模拟真实用户跑疑难20例(HS_RULINGS=1,追问用商品事实回答),服务 ' + baseUrl + '\n');

  const results = new Array(fixture.cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < fixture.cases.length) {
      const i = cursor++;
      const r = await runCase(fixture.cases[i], baseUrl);
      results[i] = r;
      console.log((r.correct ? 'PASS' : 'FAIL') + ' ' + r.id + ' ' + r.productName +
        ' | 期望' + r.expectedCode + ' 实际' + (r.finalCode || '无') +
        ' | 追问' + (r.asked ? '是(' + r.answered + '答)' : '否') +
        ' | 判例' + (r.caseHits.length || 0) + '命中/补' + (r.addedCodes.length || 0) + '码' +
        ' | ' + r.status + (r.degraded ? ' [降级]' : '') + (r.detail ? ' ' + r.detail : ''));
    }
  }
  await Promise.all(Array.from({ length: 2 }, worker));

  const correct = results.filter(r => r.correct).length;
  const asked = results.filter(r => r.asked).length;
  const refused = results.filter(r => r.status === 'refused').length;
  const errors = results.filter(r => r.status === 'error').length;
  const degraded = results.filter(r => r.degraded).length;
  const caseHit = results.filter(r => r.caseHits.length).length;
  const cov = results.filter(r => r.coveredByCorpus === true), ncov = results.filter(r => r.coveredByCorpus === false);
  console.log('\n========== 汇总(疑难20例·模拟真实用户·判例开启)==========');
  console.log('精确正确: ' + correct + '/20 (' + (correct / 20 * 100).toFixed(0) + '%)');
  console.log('追问例数: ' + asked + ' | 拒答: ' + refused + ' | 接口错误: ' + errors + ' | 降级: ' + degraded + ' | 判例命中例数: ' + caseHit);
  console.log('判例在库' + cov.length + '例: ' + cov.filter(r => r.correct).length + '对 | 判例不在库' + ncov.length + '例: ' + ncov.filter(r => r.correct).length + '对');
  console.log('\n逐例:');
  for (const r of results) console.log('  ' + (r.correct ? '✓' : '✗') + ' ' + r.id + ' ' + r.productName + ' 期望' + r.expectedCode + ' 实际' + (r.finalCode || '无') + (r.coveredByCorpus === null ? '' : (r.coveredByCorpus ? ' [判例在库]' : ' [判例不在库]')));
  fs.writeFileSync(path.join(__dirname, 'difficult-user-sim-result.json'), JSON.stringify({ config: { dataset: 'difficult', rulings: true, simulateUser: true }, summary: { correct, total: 20, asked, refused, errors, degraded, caseHit }, results }, null, 2));
  console.log('\n结果已保存 tools/debug/difficult-user-sim-result.json');
  await new Promise(res => listener.close(res));
  process.exit(0);
})();
