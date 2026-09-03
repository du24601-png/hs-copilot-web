#!/usr/bin/env node
// 出海电商数据集端到端回归 + 模拟用户答题
// 与 tools/test-real-products-20-v2.cjs 的区别：
//   ① 读 test/fixtures/export-seller-noisy-20.json（出海电商数据集）；
//   ② 模拟真实用户答题：classify 若追问，则选“codes 命中 expectedCode 的选项”（模拟了解自己商品的用户），
//      无匹配选项时用 freeText 补充商品真实描述——而非旧工具那样忽略追问、空答案 decide。
// 用法：node tools/test-export-seller-20.cjs --base-url http://127.0.0.1:7113 --concurrency 3
//   需服务端以 HS_DEBUG=1 启动（读取 stats.poolCodes 计算召回）。

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixturePath = path.join(root, 'test', 'fixtures', 'export-seller-noisy-20.json');

function readArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const baseUrl = readArg('--base-url', process.env.HS_BASE_URL || 'http://127.0.0.1:7113').replace(/\/$/, '');
const outputPath = path.resolve(readArg('--output', path.join(__dirname, 'export-seller-20-result.json')));
const concurrency = Math.max(1, Math.min(4, Number(readArg('--concurrency', '3')) || 3));
const timeoutMs = Math.max(1000, Number(readArg('--timeout-ms', '120000')) || 120000);

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const cases = fixture.cases;

async function postJson(route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(route + ' non-JSON: ' + text.slice(0, 120)); }
    if (!response.ok) throw new Error(payload.error || route + ' HTTP ' + response.status);
    return payload;
  } finally { clearTimeout(timer); }
}

// 模拟用户答题：优先选 codes 命中 expectedCode 的选项（模拟了解自己商品的用户）；
// 没有选项导向正确答案时，否定并用 freeText 补充商品真实描述。
function simulateAnswer(question, expectedCode, description) {
  if (!question || !Array.isArray(question.options)) return [];
  const attr = question.attr || '关键确认';
  const hit = question.options.find(o => Array.isArray(o.codes) && o.codes.includes(expectedCode));
  if (hit) return [{ attr, answer: hit.label, freeText: '' }];
  return [{ attr, answer: '以上都不是（我补充说明）', freeText: String(description).slice(0, 200) }];
}

async function runCase(item) {
  const started = performance.now();
  const expectedHeading = item.expectedCode.slice(0, 4);
  try {
    const phase1 = await postJson('/api/classify', { query: item.description });
    const stats1 = phase1.stats || {};
    const poolCodes = stats1.poolCodes || (phase1.candidates || []).map(c => c.code);
    const headingHit = poolCodes.some(code => code.slice(0, 4) === expectedHeading);
    const hs10Hit = poolCodes.includes(item.expectedCode);
    const asked = Array.isArray(phase1.questions) && phase1.questions.length > 0;

    if (phase1.refuse) {
      return { id: item.id, productName: item.productName, expectedCode: item.expectedCode, finalCode: null, correct: false, status: 'refused-before-decision', headingHit, hs10Hit, asked, answered: false, poolSize: poolCodes.length, llmCalls: stats1.llmCalls || 0, latencyMs: Math.round(performance.now() - started), detail: phase1.refuseReason || '' };
    }

    const answers = simulateAnswer(phase1.questions && phase1.questions[0], item.expectedCode, item.description);
    const phase2 = await postJson('/api/decide', { query: item.description, knownAttrs: Array.isArray(phase1.knownAttrs) ? phase1.knownAttrs : [], answers });
    const stats2 = phase2.stats || {};
    const finalCode = phase2.selectedCode ? String(phase2.selectedCode) : null;

    return {
      id: item.id, productName: item.productName, expectedCode: item.expectedCode, finalCode,
      correct: finalCode === item.expectedCode,
      status: phase2.refuse || !finalCode ? 'refused' : 'decided',
      headingHit, hs10Hit, asked, answered: answers.length > 0,
      poolSize: poolCodes.length, llmCalls: (stats1.llmCalls || 0) + (stats2.llmCalls || 0),
      latencyMs: Math.round(performance.now() - started), detail: phase2.refuseReason || ''
    };
  } catch (error) {
    return { id: item.id, productName: item.productName, expectedCode: item.expectedCode, finalCode: null, correct: false, status: 'error', headingHit: false, hs10Hit: false, asked: false, answered: false, poolSize: 0, llmCalls: 0, latencyMs: Math.round(performance.now() - started), detail: String(error.message || error) };
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const results = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++;
      results[index] = await runCase(cases[index]);
      const r = results[index];
      console.log((r.correct ? 'PASS' : 'FAIL') + ' ' + r.id + ' expect=' + r.expectedCode + ' final=' + (r.finalCode || 'none')
        + ' | heading=' + (r.headingHit ? 'Y' : 'N') + ' hs10=' + (r.hs10Hit ? 'Y' : 'N')
        + ' asked=' + (r.asked ? 'Y' : 'N') + ' pool=' + r.poolSize + ' llm=' + r.llmCalls);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const correct = results.filter(r => r.correct).length;
  const asked = results.filter(r => r.asked).length;
  const refuses = results.filter(r => r.status.startsWith('refused')).length;
  const errors = results.filter(r => r.status === 'error').length;
  const avg = v => v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
  const summary = {
    total: results.length, correct,
    exactMatchRate: Number((correct / results.length).toFixed(4)),
    askedCount: asked, refuses, errors,
    headingRecall: results.filter(r => r.headingHit).length,
    hs10CandidateRecall: results.filter(r => r.hs10Hit).length,
    meanLatencyMs: Math.round(avg(latencies)),
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
    meanPoolSize: Number(avg(results.map(r => r.poolSize)).toFixed(1)),
    meanLlmCalls: Number(avg(results.map(r => r.llmCalls)).toFixed(2))
  };
  const report = {
    startedAt, completedAt: new Date().toISOString(), baseUrl,
    dataset: 'export-seller-noisy-20 (出海电商数据集)',
    method: 'classify -> simulate user answer (choose option whose codes include expectedCode, else supplement via freeText) -> decide -> exact match',
    summary, results
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('\naccuracy: ' + correct + '/' + results.length + ' (' + (summary.exactMatchRate * 100).toFixed(1) + '%)');
  console.log('asked: ' + asked + '/' + results.length + ', headingRecall: ' + summary.headingRecall + ', hs10Recall: ' + summary.hs10CandidateRecall);
  console.log('refuse: ' + refuses + ', error: ' + errors + ', meanLatency: ' + summary.meanLatencyMs + 'ms, p95: ' + summary.p95LatencyMs + 'ms');
  console.log('report: ' + outputPath);
  process.exitCode = 0;
}
main();
