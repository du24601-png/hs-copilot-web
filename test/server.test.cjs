const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
const handlesBeforeImport = new Set(process._getActiveHandles());
const server = require('../server.js');
const importedListeners = () => process._getActiveHandles().filter(handle =>
  handle && handle.constructor && handle.constructor.name === 'Server' && !handlesBeforeImport.has(handle));

test.after(async () => {
  await new Promise(resolve => setImmediate(resolve));
  importedListeners().forEach(listener => listener.close());
});

test('server module can be imported without opening a listener', () => {
  assert.equal(typeof server.startServer, 'function');
  assert.equal(importedListeners().length, 0);
});

test('normalizePlan clamps malformed LLM planning output', () => {
  const plan = server.normalizePlan({
    core: {
      word: '不锈钢真空保温杯超长商品名称',
      alt: ['保温瓶', 123, '真空容器', '家用器皿', '杯', '水瓶', '多余项'],
      chapters: ['第96章', '85', 'x7', '123']
    },
    structure: { word: '真空双层结构' },
    material: { word: '不锈钢' },
    params: [{ key: '容量', value: '500ml', affectsCode: 0 }, null, { key: '功率', value: 30, affectsCode: 1 }],
    confidence: 'certain'
  });
  assert.equal(plan.core.word.length <= 20, true);
  assert.deepEqual(plan.core.alt, ['保温瓶', '123', '真空容器', '家用器皿', '杯', '水瓶']);
  assert.deepEqual(plan.core.chapters, ['96', '85', '12']);
  assert.deepEqual(plan.params, [
    { key: '容量', value: '500ml', affectsCode: false },
    { key: '功率', value: '30', affectsCode: true }
  ]);
  assert.equal(plan.confidence, 'low');
});

test('mergeCandidateCodes boosts plan terms while retaining literal candidates', () => {
  const plan = {
    core: { word: '保温杯', alt: ['保温瓶'], chapters: ['96'] },
    structure: { word: '真空' },
    material: { word: '不锈钢' },
    params: [],
    confidence: 'high'
  };
  const byWord = {
    '保温杯': ['9617009000'],
    '保温瓶': ['9617009000', '9617001000'],
    '真空': ['9617009000'],
    '不锈钢': ['7219331000']
  };
  const merged = server.mergeCandidateCodes(
    plan,
    ['7013370000', '7219331000'],
    word => byWord[word] || [],
    () => ['9617009000']
  );
  assert.equal(merged.picked[0], '9617009000');
  assert.equal(merged.picked.includes('7013370000'), true);
  assert.equal(merged.picked.length <= 16, true);
});

test('bestNgramMatches keeps the strongest match at every substring length', () => {
  const rowsByWord = {
    '不锈钢': [{ code: '7219' }],
    '保温': [{ code: '9617' }],
    '真空': Array.from({ length: 20 }, (_, index) => ({ code: 'x' + index }))
  };
  const matches = server.bestNgramMatches('不锈钢真空保温杯', word => rowsByWord[word] || []);
  assert.deepEqual(matches.map(match => match.word), ['不锈钢', '保温']);
});

test('pickRetrievalGroups guarantees representation from six headings', () => {
  const byHeading = new Map();
  for (let heading = 1; heading <= 7; heading++) {
    const prefix = String(heading).padStart(4, '0');
    byHeading.set(prefix, Array.from({ length: 12 }, (_, index) => [
      prefix + String(index).padStart(6, '0'),
      100 - heading * 5 - index
    ]));
  }
  const picked = server.pickRetrievalGroups(byHeading);
  assert.equal(picked.length, 16);
  assert.equal(new Set(picked.map(([code]) => code.slice(0, 4))).size, 6);
  assert.equal(picked.filter(([code]) => code.startsWith('0001')).length, 8);
  assert.equal(picked.some(([code]) => code.startsWith('0007')), false);
});

test('searchHs reuses candidate retrieval for long Chinese descriptions', () => {
  const rows = server.searchHs('不锈钢保温杯');
  assert.equal(rows.length >= 3, true);
  assert.equal(rows.every(row => /^\d{10}$/.test(row.code)), true);
});

test('AI-planned terms can bypass the literal single-character head boost', () => {
  const focused = server.retrieveCandidates('保温杯', [], { useHeadBoost: false });
  assert.equal(focused[0].code.startsWith('9617'), true);
});
