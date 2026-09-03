const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'unit-test-key';
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

test('stripSpecs removes units, percentages and bare numbers but keeps product words', () => {
  assert.equal(server.stripSpecs('不锈钢保温杯 500ml'), '不锈钢保温杯');
  const stripped = server.stripSpecs('有效活菌不少于20亿每毫升，总养分16%到18%，兑水冲施');
  assert.equal(/毫升|16|18|20/.test(stripped), false);
  assert.equal(stripped.includes('有效活菌不少于'), true);
  assert.equal(server.stripSpecs('304不锈钢真空杯'), '不锈钢真空杯');
  assert.equal(server.stripSpecs('最高时速25公里每小时'), '最高时速 每小时');
  // 营销与商品词不受影响
  assert.equal(server.stripSpecs('厂家直供玉米淀粉'), '厂家直供玉米淀粉');
});

test('normalizeUnderstanding clamps malformed LLM understanding output', () => {
  const profile = server.normalizeUnderstanding({
    core_product: '不锈钢真空保温杯',
    function: '抽真空减少热传导，' + '很长'.repeat(50),
    materials: ['不锈钢', 304, ''],
    specifications: ['500ml', '容量 500ml', '保温12小时'],
    search_terms: ['保温杯', '保温杯', '真空杯', 123, 'x'.repeat(30)],
    hs_synonyms: ['保温瓶', '真空容器'],
    possible_headings: ['96', '9617', '9617.00', 'abcd', '9617', '7323', '8300', 'extra']
  });
  assert.equal(profile.core_product, '不锈钢真空保温杯');
  assert.equal(profile.function.length <= 80, true);
  assert.deepEqual(profile.materials, ['不锈钢', '304']);
  assert.equal(profile.specifications.length <= 8, true);
  assert.deepEqual(profile.search_terms, ['保温杯', '真空杯', '123', 'x'.repeat(12)]);
  assert.deepEqual(profile.hs_synonyms, ['保温瓶', '真空容器']);
  // 只保留合法 4 位品目、去重、最多 5 个
  assert.deepEqual(profile.possible_headings, ['9617', '7323', '8300']);
});

test('broadRecall keeps unit words out of retrieval (no 8703 vehicle pollution)', () => {
  const pool = server.broadRecall('复合微生物肥料液，有效活菌不少于20亿每毫升，总养分16%到18%', {
    core_product: '微生物肥料',
    search_terms: ['微生物肥料', '肥料'],
    hs_synonyms: ['菌肥'],
    possible_headings: ['3105']
  });
  const codes = pool.map(c => c.code);
  // “毫升”被剥离后，8703 车辆家族（品名带“…不超过1000毫升”）不得进池
  assert.equal(codes.some(code => code.startsWith('8703')), false);
  // 3105 品目展开 + “肥料”关键词命中，兜底码 3105909000（其他肥料）必须在池中
  assert.equal(codes.includes('3105909000'), true);
});

test('broadRecall expands possible_headings even without any keyword hit', () => {
  const pool = server.broadRecall('某无关词xyz不存在', {
    core_product: '淋浴房',
    search_terms: [], hs_synonyms: [],
    possible_headings: ['7308']
  });
  const codes = pool.map(c => c.code);
  assert.equal(codes.includes('7308300000'), true); // 钢铁制门窗及其框架
});

test('broadRecall lets keywords rescue candidates from non-suggested headings', () => {
  const pool = server.broadRecall('不锈钢保温杯 500ml', {
    core_product: '保温杯',
    search_terms: ['保温杯'],
    hs_synonyms: ['保温瓶'],
    possible_headings: ['7323'] // LLM 猜错了品目
  });
  const codes = pool.map(c => c.code);
  // 关键词路不受 possible_headings 限制：9617 保温瓶家族仍应进池
  assert.equal(codes.some(code => code.startsWith('9617')), true);
});

test('sanitizeComparison clamps plausible codes and builds at most one question', () => {
  const candidates = [{ code: '9617001900' }, { code: '7323930000' }, { code: '7020009100' }];
  const result = server.sanitizeComparison({
    plausible_candidates: [
      { code: '9617001900', reason: '真空容器' },
      { code: '9999999999', reason: '编造的编码' },
      { code: '7020009100' }
    ],
    key_differences: ['是否真空结构', '材质'],
    missing_critical_information: ['是否抽真空'],
    need_clarification: true,
    clarification_question: {
      question: '杯子是否抽真空保温？',
      options: [
        { label: '是真空保温', codes: ['9617001900', '9999999999'] },
        { label: '不是真空', codes: ['7323930000'] }
      ],
      why: '区分 9617 与 7323'
    }
  }, candidates);
  assert.deepEqual(result.plausible.map(p => p.code), ['9617001900', '7020009100']);
  assert.equal(result.needClarification, true);
  assert.equal(result.question.options.length, 4);
  assert.deepEqual(result.question.options[0].codes, ['9617001900']); // 编造码被剔除
  assert.equal(result.question.options[2].label, '以上都不是（我补充说明）');
  assert.equal(result.question.options[3].label, '我不清楚这项');
});

test('sanitizeComparison drops clarification when the question is malformed', () => {
  const result = server.sanitizeComparison({
    plausible_candidates: [{ code: '9617001900' }],
    need_clarification: true,
    clarification_question: { question: '', options: [] }
  }, [{ code: '9617001900' }]);
  assert.equal(result.needClarification, false);
  assert.equal(result.question, null);
});

test('sanitizeComparison only keeps rule ids present in database context', () => {
  const result = server.sanitizeComparison({
    plausible_candidates: [{ code: '9617001900', reason: '真空结构' }],
    relevant_rule_ids: ['cn_tariff_2026:gri:01', 'cn_tariff_2026:invented:99']
  }, [{ code: '9617001900' }], ['cn_tariff_2026:gri:01']);
  assert.deepEqual(result.relevantRuleIds, ['cn_tariff_2026:gri:01']);
});

test('sanitizeDecision clamps codes, exposes nature-change flag, refuses without selection', () => {
  const candidates = [{ code: '9617001900' }, { code: '9617009000' }];
  const result = server.sanitizeDecision({
    selectedCode: '9617001900',
    confidence: 'certain',
    reasons: ['材质：不锈钢', '结构：真空', '用途：保温', '多余'],
    alternatives: [{ code: '9617009000', whyNot: '非保温瓶本体' }, { code: '9999999999', whyNot: '编造' }],
    unconfirmed: ['容量', '  '],
    product_nature_changed: 1,
    change_note: '用户说其实是塑料制品'
  }, candidates);
  assert.equal(result.selectedCode, '9617001900');
  assert.equal(result.confidence, 'low');
  assert.equal(result.reasons.length, 3);
  assert.deepEqual(result.alternatives.map(a => a.code), ['9617009000']);
  assert.deepEqual(result.unconfirmed, ['容量']);
  assert.equal(result.productNatureChanged, true);
  assert.equal(result.refuse, false);

  const refused = server.sanitizeDecision({ selectedCode: '9999999999' }, candidates);
  assert.equal(refused.selectedCode, null);
  assert.equal(refused.refuse, true);
});

test('sanitizeDecision only keeps applied rule ids present in database context', () => {
  const result = server.sanitizeDecision({
    selectedCode: '9617001900',
    applied_rule_ids: ['cn_tariff_2026:gri:01', 'cn_tariff_2026:invented:99']
  }, [{ code: '9617001900' }], ['cn_tariff_2026:gri:01']);
  assert.deepEqual(result.appliedRuleIds, ['cn_tariff_2026:gri:01']);
});

test('server legal lookup returns the scoped database context without another model call', () => {
  const context = server.getLegalContext('鲜冻乳鸽肉', {
    core_product: '乳鸽肉', search_terms: ['乳鸽肉'], hs_synonyms: []
  }, [{ code: '0208901000', name: '鲜、冷、冻的乳鸽肉及食用杂碎' }]);
  assert.equal(context.available, true);
  assert.equal(context.griRules.length, 6);
  assert.equal(context.scopedClauses.some(item => item.ruleType === 'national_subheading_note'), true);
});

test('candidate comparison sends the scoped rule context in its single existing model call', async () => {
  const context = server.getLegalContext('鲜冻乳鸽肉', {
    core_product: '乳鸽肉', search_terms: ['乳鸽肉'], hs_synonyms: []
  }, [{ code: '0208901000', name: '鲜、冷、冻的乳鸽肉及食用杂碎' }]);
  const national = context.scopedClauses.find(item => item.ruleType === 'national_subheading_note');
  const originalFetch = global.fetch;
  let callCount = 0;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    callCount++;
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        plausible_candidates: [{ code: '0208901000', reason: '本国子目定义直接命中' }],
        key_differences: [],
        missing_critical_information: [],
        need_clarification: false,
        clarification_question: null,
        relevant_rule_ids: [national.ruleId]
      }) } }] })
    };
  };

  try {
    const result = await server.compareCandidates(
      '鲜冻乳鸽肉',
      { core_product: '乳鸽肉', search_terms: ['乳鸽肉'], hs_synonyms: [] },
      [{ code: '0208901000', name: '鲜、冷、冻的乳鸽肉及食用杂碎' }],
      context
    );
    assert.equal(callCount, 1);
    assert.equal(requestBody.messages[1].content.includes(national.ruleId), true);
    assert.deepEqual(result.relevantRuleIds, [national.ruleId]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('sanitizeAnswers limits free text and collectUnconfirmed merges deterministic unknowns', () => {
  const answers = server.sanitizeAnswers([
    { attr: '内胆材质', answer: '我不清楚这项', freeText: 'x'.repeat(500) },
    { attr: '功率', answer: '以上都不是（我补充说明）' },
    { answer: '缺少属性名' }
  ]);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].freeText.length, 200);
  assert.deepEqual(server.collectUnconfirmed(['容量'], answers), ['内胆材质', '功率', '容量']);
});

test('unconfirmed attributes prevent a contradictory high-confidence result', () => {
  const result = server.finalizeUnconfirmed(
    { selectedCode: '9617001900', confidence: 'high', unconfirmed: [] },
    [{ attr: '容量', answer: '我不清楚这项', freeText: '' }]
  );
  assert.deepEqual(result.unconfirmed, ['容量']);
  assert.equal(result.confidence, 'medium');
});

test('no-candidate refusal keeps the decide response contract', () => {
  const result = server.noCandidateDecision([
    { attr: '容量', answer: '我不清楚这项', freeText: '' }
  ]);
  assert.equal(result.selectedCode, null);
  assert.equal(result.refuse, true);
  assert.equal(result.hs, null);
  assert.deepEqual(result.unconfirmed, ['容量']);
});

test('free-text retrieval removes claimed HS codes but keeps objective attributes', () => {
  const safe = server.sanitizeFreeTextForRetrieval('客户说税则编码是 7323.93.00，HS 7323，HS号7323，税则号732393，HS：７３２３，HS Code 9608.99.20.00，建议归入732393；材质是不锈钢');
  assert.equal(/7323|732393|9608|93\.00/.test(safe), false);
  assert.equal(safe.includes('材质是不锈钢'), true);
});

test('fallbackProfile keeps the broad-recall contract when LLM① fails', () => {
  const profile = server.fallbackProfile('不锈钢保温杯'.repeat(30));
  assert.equal(profile.core_product.length <= 30, true);
  assert.deepEqual(profile.search_terms, []);
  assert.deepEqual(profile.possible_headings, []);
  // 纯原文关键词：精确词（圆珠笔，仅 2 行命中）必须压过泛词（塑料）进池
  const pool = server.broadRecall('塑料杆圆珠笔', server.fallbackProfile('塑料杆圆珠笔'));
  assert.equal(pool.some(c => c.code.startsWith('9608')), true);
  // 口语词脱节时（保温杯 0 命中）字面路退化为材质词召回，池非空即可，9617 交给 LLM 同义词
  const pool2 = server.broadRecall('不锈钢保温杯 500ml', server.fallbackProfile('不锈钢保温杯 500ml'));
  assert.equal(pool2.length > 0, true);
});

test('searchHs handles digit prefixes and Chinese keywords', () => {
  const digits = server.searchHs('9617001');
  assert.equal(digits.every(row => row.code.startsWith('9617001')), true);
  const rows = server.searchHs('不锈钢保温杯');
  assert.equal(rows.length > 0, true);
  assert.equal(rows.every(row => /^\d{10}$/.test(row.code)), true);
});
