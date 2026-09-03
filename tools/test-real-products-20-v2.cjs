#!/usr/bin/env node
// 真实商品 20 例端到端回归（AI-native 简化链路版）
// 与旧工具的区别：额外从 HS_DEBUG 响应里读取候选池，计算 Heading Recall / HS10 Candidate Recall，
// 并统计平均候选数与平均 LLM 调用次数。需要服务端以 HS_DEBUG=1 启动。

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixturePath = path.join(root, 'test', 'fixtures', 'real-products-noisy-20.json');
const defaultOutput = path.join(__dirname, 'real-products-20-simplified.json');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = readArg('--base-url', process.env.HS_BASE_URL || 'http://127.0.0.1:7109').replace(/\/$/, '');
const outputPath = path.resolve(readArg('--output', defaultOutput));
const concurrency = Math.max(1, Math.min(4, Number(readArg('--concurrency', '2')) || 2));
const timeoutMs = Math.max(1000, Number(readArg('--timeout-ms', '120000')) || 120000);
const selectedIds = new Set(String(readArg('--only', '')).split(',').map(value => value.trim()).filter(Boolean));

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const cases = selectedIds.size ? fixture.cases.filter(item => selectedIds.has(item.id)) : fixture.cases;

if (!cases.length) {
  console.error('没有匹配的测试案例。可用格式：--only real-001,real-002');
  process.exit(2);
}

async function postJson(route, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw new Error(`${route} 返回的不是 JSON：${text.slice(0, 120)}`);
    }
    if (!response.ok) throw new Error(payload.error || `${route} HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
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

    if (phase1.refuse) {
      return {
        id: item.id, productName: item.productName,
        expectedCode: item.expectedCode, finalCode: null, correct: false,
        status: 'refused-before-decision',
        headingHit, hs10Hit, poolSize: poolCodes.length, poolCodes,
        llmCalls: stats1.llmCalls || 0,
        latencyMs: Math.round(performance.now() - started),
        detail: phase1.refuseReason || '阶段一拒答'
      };
    }

    // 与旧基准一致：故意忽略确认问题，空答案直接 decide
    const phase2 = await postJson('/api/decide', {
      query: item.description,
      knownAttrs: Array.isArray(phase1.knownAttrs) ? phase1.knownAttrs : [],
      answers: []
    });
    const stats2 = phase2.stats || {};
    const finalCode = phase2.selectedCode ? String(phase2.selectedCode) : null;

    return {
      id: item.id, productName: item.productName,
      expectedCode: item.expectedCode, finalCode,
      correct: finalCode === item.expectedCode,
      status: phase2.refuse || !finalCode ? 'refused' : 'decided',
      headingHit, hs10Hit, poolSize: poolCodes.length, poolCodes,
      llmCalls: (stats1.llmCalls || 0) + (stats2.llmCalls || 0),
      latencyMs: Math.round(performance.now() - started),
      detail: phase2.refuseReason || ''
    };
  } catch (error) {
    return {
      id: item.id, productName: item.productName,
      expectedCode: item.expectedCode, finalCode: null, correct: false,
      status: 'error', headingHit: false, hs10Hit: false, poolSize: 0, poolCodes: [], llmCalls: 0,
      latencyMs: Math.round(performance.now() - started),
      detail: error.name === 'AbortError' ? `超过 ${timeoutMs}ms` : String(error.message || error)
    };
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
      const item = results[index];
      const mark = item.correct ? 'PASS' : 'FAIL';
      console.log(`${mark} ${item.id} ${item.productName}: 期望 ${item.expectedCode}，最终 ${item.finalCode || '无'}`
        + ` | heading=${item.headingHit ? '✓' : '✗'} hs10=${item.hs10Hit ? '✓' : '✗'} pool=${item.poolSize} llm=${item.llmCalls}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const latencies = results.map(item => item.latencyMs).sort((a, b) => a - b);
  const correct = results.filter(item => item.correct).length;
  const refuses = results.filter(item => item.status.startsWith('refused')).length;
  const errors = results.filter(item => item.status === 'error').length;
  const avg = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  const summary = {
    total: results.length,
    correct,
    exactMatchRate: Number((correct / results.length).toFixed(4)),
    refuses,
    errors,
    headingRecall: results.filter(item => item.headingHit).length,
    hs10CandidateRecall: results.filter(item => item.hs10Hit).length,
    meanLatencyMs: Math.round(avg(latencies)),
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)],
    meanPoolSize: Number(avg(results.map(item => item.poolSize)).toFixed(1)),
    meanLlmCalls: Number(avg(results.map(item => item.llmCalls)).toFixed(2))
  };
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl,
    pipeline: 'ai-native-simplified (understand -> broad recall -> compare -> decide, temperature=0)',
    method: 'description -> classify -> ignore questions -> decide with empty answers -> exact selectedCode match',
    summary,
    results
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n准确率：${correct}/${results.length} (${(summary.exactMatchRate * 100).toFixed(1)}%)`);
  console.log(`Heading Recall：${summary.headingRecall}/${results.length}，HS10 候选召回：${summary.hs10CandidateRecall}/${results.length}`);
  console.log(`拒答：${refuses}，错误：${errors}，平均耗时：${summary.meanLatencyMs}ms，P95：${summary.p95LatencyMs}ms`);
  console.log(`平均候选数：${summary.meanPoolSize}，平均 LLM 调用：${summary.meanLlmCalls} 次`);
  console.log(`报告：${outputPath}`);
  process.exitCode = correct === results.length ? 0 : 1;
}

main();
