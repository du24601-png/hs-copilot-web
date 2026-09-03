#!/usr/bin/env node
// 单案例全链路追踪（in-process，不经过 HTTP）：理解 → 宽召回 → 比较 → 终选
// 用法: node tools/probe-pipeline.cjs real-019,real-002          —— 跑测试集案例
//       node tools/probe-pipeline.cjs --query "不锈钢保温杯 500ml" —— 跑任意描述
//       node tools/probe-pipeline.cjs --tag run2 real-019         —— 输出文件名加后缀（稳定性对比用）

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = require(root + '/server.js');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const tag = readArg('--tag') ? '-' + readArg('--tag') : '';
const adhocQuery = readArg('--query');
const positional = process.argv.slice(2).filter((value, index, all) =>
  !value.startsWith('--') && all[index - 1] !== '--tag' && all[index - 1] !== '--query');

let items;
if (adhocQuery) {
  items = [{ id: 'adhoc', productName: '自定义', description: adhocQuery, expectedCode: null }];
} else {
  const fixture = JSON.parse(fs.readFileSync(root + '/test/fixtures/real-products-noisy-20.json', 'utf8'));
  const ids = positional.length ? positional[0].split(',') : ['real-019', 'real-002'];
  items = fixture.cases.filter(item => ids.includes(item.id));
}

async function trace(item) {
  const t0 = Date.now();
  const profile = await server.understandProduct(item.description);
  const candidates = server.broadRecall(item.description, profile);
  const comparison = await server.compareCandidates(item.description, profile, candidates);
  const decision = await server.llmDecide(item.description, profile, [], candidates, comparison);

  const traceOut = {
    id: item.id,
    productName: item.productName,
    expectedCode: item.expectedCode,
    description: item.description,
    step1_profile: profile,
    step2_recall: {
      poolSize: candidates.length,
      pool: candidates.map(c => ({ code: c.code, name: c.name })),
      expectedInPool: item.expectedCode ? candidates.some(c => c.code === item.expectedCode) : null,
      expectedHeadingInPool: item.expectedCode
        ? candidates.some(c => c.code.slice(0, 4) === item.expectedCode.slice(0, 4)) : null
    },
    step3_comparison: comparison,
    step4_decision: {
      selectedCode: decision.selectedCode, confidence: decision.confidence,
      reasons: decision.reasons, refuse: decision.refuse, refuseReason: decision.refuseReason,
      alternatives: decision.alternatives, productNatureChanged: decision.productNatureChanged,
      model: decision.__model
    },
    correct: item.expectedCode ? decision.selectedCode === item.expectedCode : null,
    totalMs: Date.now() - t0
  };

  const outDir = path.join(__dirname, 'debug');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, item.id + tag + '.json');
  fs.writeFileSync(outFile, JSON.stringify(traceOut, null, 2) + '\n', 'utf8');
  console.log(`\n=== ${item.id} ${item.productName} (${traceOut.totalMs}ms) ===`);
  console.log('期望:', item.expectedCode, '| 选中:', decision.selectedCode, '| 正确:', traceOut.correct);
  console.log('画像:', JSON.stringify(profile));
  console.log(`候选池 ${candidates.length} 条 | 期望品目在池: ${traceOut.step2_recall.expectedHeadingInPool} | 期望编码在池: ${traceOut.step2_recall.expectedInPool}`);
  console.log('plausible:', comparison.plausible.map(p => p.code).join(', ') || '(空)');
  console.log('需追问:', comparison.needClarification, comparison.question ? comparison.question.question : '');
  console.log('决定理由:', decision.reasons.join(' / ') || decision.refuseReason);
  console.log('追踪文件:', outFile);
}

(async () => {
  for (const item of items) {
    try { await trace(item); }
    catch (e) { console.error(`${item.id} 追踪失败:`, e.message); }
  }
  process.exit(0);
})();
