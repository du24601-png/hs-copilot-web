const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const {
  createLegalKnowledgeRepository,
  formatLegalContext,
  publicReferences
} = require('../legal-knowledge.js');

const db = new DatabaseSync('hs_copilot.db', { readOnly: true });
const repository = createLegalKnowledgeRepository(db);

test.after(() => db.close());

test('candidate scope retrieves GRI, national note, chapter note and section note', () => {
  const context = repository.queryForCandidates(
    '鲜冻乳鸽肉，20日龄',
    { core_product: '乳鸽肉', search_terms: ['乳鸽肉', '乳鸽'], hs_synonyms: [] },
    [{ code: '0208901000', name: '鲜、冷、冻的乳鸽肉及食用杂碎' }]
  );

  assert.equal(context.available, true);
  assert.equal(context.griRules.length, 6);
  assert.equal(context.scopedClauses.some(item => item.ruleType === 'national_subheading_note'), true);
  assert.equal(context.scopedClauses.some(item => item.ruleId.endsWith(':chapter:02')), true);
  assert.equal(context.scopedClauses.some(item => item.ruleId.endsWith(':section:01')), true);
  assert.equal(context.complianceNotices.length, 0);
  assert.equal(new Set(context.allowedRuleIds).size, context.allowedRuleIds.length);

  const prompt = formatLegalContext(context);
  assert.equal(prompt.includes('cn_tariff_2026'), true);
  assert.equal(prompt.includes('本国子目'), true);
  assert.equal(prompt.length <= context.maxChars, true);
});

test('compliance notice is returned separately and never enters classification clauses', () => {
  const context = repository.queryForCandidates(
    '鸦片液汁及浸膏',
    { core_product: '鸦片液汁', search_terms: ['鸦片'], hs_synonyms: [] },
    [{ code: '1302110000', name: '鸦片液汁及浸膏' }]
  );

  assert.equal(context.complianceNotices.length, 1);
  assert.equal(context.complianceNotices[0].ruleType, 'compliance_notice');
  assert.equal(context.scopedClauses.some(item => item.ruleType === 'compliance_notice'), false);
  assert.equal(context.allowedRuleIds.includes(context.complianceNotices[0].ruleId), false);
});

test('rule context stays bounded and unknown candidates degrade safely to global GRI', () => {
  const context = repository.queryForCandidates(
    '没有匹配的虚构商品',
    { core_product: '虚构商品', search_terms: [], hs_synonyms: [] },
    [{ code: '9999999999', name: '不存在' }],
    { maxChars: 9000, maxScopedClauses: 24 }
  );

  assert.equal(context.griRules.length, 6);
  assert.deepEqual(context.scopedClauses, []);
  assert.equal(formatLegalContext(context).length <= 9000, true);
});

test('publicReferences only exposes whitelisted applied rule ids', () => {
  const context = repository.queryForCandidates(
    '鲜冻乳鸽肉',
    { core_product: '乳鸽肉', search_terms: ['乳鸽肉'], hs_synonyms: [] },
    [{ code: '0208901000', name: '鲜、冷、冻的乳鸽肉及食用杂碎' }]
  );
  const national = context.scopedClauses.find(item => item.ruleType === 'national_subheading_note');
  const refs = publicReferences(context, [national.ruleId, 'cn_tariff_2026:invented:99']);

  assert.equal(refs.length, 1);
  assert.equal(refs[0].ruleId, national.ruleId);
  assert.equal(refs[0].sourceId, 'cn_tariff_2026');
  assert.equal(refs[0].excerpt.length <= 180, true);
});
