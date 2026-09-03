#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const fixturePath = path.join(root, 'test', 'fixtures', 'real-products-noisy-20.json');
const defaultOutput = path.join(__dirname, 'real-products-20-latest.json');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = readArg('--base-url', process.env.HS_BASE_URL || 'http://127.0.0.1:7100').replace(/\/$/, '');
const outputPath = path.resolve(readArg('--output', defaultOutput));
const concurrency = Math.max(1, Math.min(4, Number(readArg('--concurrency', '2')) || 2));
const timeoutMs = Math.max(1000, Number(readArg('--timeout-ms', '30000')) || 30000);
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
    try {
      payload = JSON.parse(text);
    } catch {
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

  try {
    const phase1 = await postJson('/api/classify', { query: item.description });
    if (phase1.refuse) {
      return {
        id: item.id,
        productName: item.productName,
        expectedCode: item.expectedCode,
        finalCode: null,
        correct: false,
        status: 'refused-before-decision',
        latencyMs: Math.round(performance.now() - started),
        detail: phase1.refuseReason || '阶段一拒答'
      };
    }

    // 本测试故意忽略确认问题：只评价原始商品描述能否得到正确的最终编码。
    const phase2 = await postJson('/api/decide', {
      query: item.description,
      knownAttrs: Array.isArray(phase1.knownAttrs) ? phase1.knownAttrs : [],
      answers: []
    });
    const finalCode = phase2.selectedCode ? String(phase2.selectedCode) : null;

    return {
      id: item.id,
      productName: item.productName,
      expectedCode: item.expectedCode,
      finalCode,
      correct: finalCode === item.expectedCode,
      status: phase2.refuse || !finalCode ? 'refused' : 'decided',
      latencyMs: Math.round(performance.now() - started),
      detail: phase2.refuseReason || ''
    };
  } catch (error) {
    return {
      id: item.id,
      productName: item.productName,
      expectedCode: item.expectedCode,
      finalCode: null,
      correct: false,
      status: 'error',
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
      console.log(`${mark} ${item.id} ${item.productName}: 期望 ${item.expectedCode}，最终 ${item.finalCode || '无'}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const latencies = results.map(item => item.latencyMs).sort((a, b) => a - b);
  const correct = results.filter(item => item.correct).length;
  const refuses = results.filter(item => item.status.startsWith('refused')).length;
  const errors = results.filter(item => item.status === 'error').length;
  const summary = {
    total: results.length,
    correct,
    exactMatchRate: Number((correct / results.length).toFixed(4)),
    refuses,
    errors,
    meanLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
    p95LatencyMs: latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)]
  };
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl,
    method: 'description -> classify -> ignore questions -> decide with empty answers -> exact selectedCode match',
    summary,
    results
  };

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\n准确率：${correct}/${results.length} (${(summary.exactMatchRate * 100).toFixed(1)}%)`);
  console.log(`拒答：${refuses}，错误：${errors}，平均耗时：${summary.meanLatencyMs}ms，P95：${summary.p95LatencyMs}ms`);
  console.log(`报告：${outputPath}`);
  process.exitCode = correct === results.length ? 0 : 1;
}

main();
