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

test('synonym aliases contribute once per layer instead of stacking duplicate hits', () => {
  const plan = {
    core: { word: '', alt: ['别名一', '别名二'], chapters: [] },
    structure: { word: '' }, material: { word: '' }, params: [], confidence: 'high'
  };
  const merged = server.mergeCandidateCodes(
    plan,
    [],
    () => ['7020009100'],
    () => [],
    { base: 0, core: 0, alt: 2, chapter: 0, structure: 0, material: 0, param: 0 }
  );
  assert.equal(merged.ranked[0][1], 2);
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

test('AI-planned compound nouns do not drift to an adjective-only tariff family', () => {
  const planned = server.retrieveCandidates('电容笔', [], { useHeadBoost: false, suffixOnly: true });
  assert.equal(planned.some(row => row.code.startsWith('8532')), false);
});

test('sanitizePhase1 normalizes option objects and clamps their codes', () => {
  const candidates = [
    { code: '9617001100' },
    { code: '9617001900' }
  ];
  const result = server.sanitizePhase1({
    questions: [{
      attr: '内胆材质',
      question: '内胆是什么材质？',
      hint: '',
      hintPlaceholder: '   ',
      options: [
        { label: '玻璃内胆', codes: ['9617001100', '7323930000'] },
        { label: '我不清楚这项', codes: ['9617001900'] }
      ]
    }],
    converged: true
  }, candidates);
  assert.deepEqual(result.questions[0].options, [
    { label: '玻璃内胆', codes: ['9617001100'] },
    { label: '我不清楚这项', codes: [] }
  ]);
  assert.equal(result.questions[0].hintPlaceholder, '例如：请描述实际材质、结构或用途');
  assert.equal(result.converged, false);
});

test('sanitizePhase1 only reports convergence when no valid questions remain', () => {
  const result = server.sanitizePhase1({
    questions: [{ question: '无效问题', options: [{ label: '' }, { label: '' }] }],
    converged: false
  }, []);
  assert.deepEqual(result.questions, []);
  assert.equal(result.converged, true);
});

test('sanitizeAnswers limits free text and collectUnconfirmed merges deterministic unknowns', () => {
  const answers = server.sanitizeAnswers([
    { attr: '内胆材质', answer: '以上都不是（我补充说明）', freeText: '' },
    { attr: '功率', answer: '我不清楚这项', freeText: 'x'.repeat(260) },
    { attr: '', answer: '无效' }
  ]);
  assert.equal(answers.length, 2);
  assert.equal(answers[1].freeText.length, 200);
  assert.deepEqual(server.collectUnconfirmed(['容量'], answers), ['内胆材质', '功率', '容量']);
});

test('deterministic unknowns take priority over model-provided unconfirmed values', () => {
  const result = server.collectUnconfirmed(
    ['模型1', '模型2', '模型3', '模型4', '模型5'],
    [{ attr: '用户未确认', answer: '以上都不是', freeText: '' }]
  );
  assert.deepEqual(result, ['用户未确认', '模型1', '模型2', '模型3', '模型4']);
});

test('unconfirmed attributes prevent a contradictory high-confidence result', () => {
  const result = server.finalizeUnconfirmed(
    { confidence: 'high', unconfirmed: [] },
    [{ attr: '内胆材质', answer: '我不清楚这项', freeText: '' }]
  );
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(result.unconfirmed, ['内胆材质']);
});

test('no-candidate refusal keeps the phase-two response contract', () => {
  const result = server.noCandidateDecision([
    { attr: '商品用途', answer: '我不清楚这项', freeText: '' }
  ]);
  assert.equal(result.selectedCode, null);
  assert.equal(result.refuse, true);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.unconfirmed, ['商品用途']);
  assert.deepEqual(result.alternatives, []);
  assert.equal(result.hs, null);
});

test('free-text retrieval removes claimed HS codes but keeps objective attributes', () => {
  const safe = server.sanitizeFreeTextForRetrieval('客户说税则编码是 7323.93.00，HS 7323，HS号7323，税则号732393，HS：７３２３，HS Code 9608.99.20.00，建议归入732393；材质是不锈钢');
  assert.equal(/7323|732393|9608|93\.00/.test(safe), false);
  assert.equal(safe.includes('不锈钢'), true);
});

test('sanitizePhase2 clamps codes and exposes bounded unconfirmed attributes', () => {
  const candidates = [{ code: '9617001900' }];
  const result = server.sanitizePhase2({
    selectedCode: '9617001900',
    alternatives: [{ code: '7323930000', whyNot: '模型编造' }],
    unconfirmed: ['内胆材质', '', 'x'.repeat(80)]
  }, candidates);
  assert.equal(result.selectedCode, '9617001900');
  assert.deepEqual(result.alternatives, []);
  assert.deepEqual(result.unconfirmed, ['内胆材质', 'x'.repeat(30)]);
});
