const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../confirm-logic.js');

const candidates = [
  { code: '9617001100' },
  { code: '9617001900' },
  { code: '7013370000' }
];

test('normalizeOption keeps compatibility with strings and object options', () => {
  assert.deepEqual(logic.normalizeOption('不确定'), { label: '不确定', codes: [] });
  assert.deepEqual(logic.normalizeOption({ label: '玻璃内胆', codes: ['9617001100'] }), {
    label: '玻璃内胆', codes: ['9617001100']
  });
  assert.deepEqual(logic.normalizeOption({ label: '我不清楚这项', codes: ['9617001100'] }), {
    label: '我不清楚这项', codes: []
  });
});

test('supplemental answer variants preserve only their bounded text draft', () => {
  assert.equal(logic.isFreeTextAnswer('以上都不是'), true);
  assert.equal(logic.isFreeTextAnswer('以上都不是（我补充说明）'), true);
  assert.equal(logic.freeTextForOption('以上都不是', 'x'.repeat(250)).length, 200);
  assert.equal(logic.freeTextForOption('玻璃内胆', '保留我'), '');
});

test('applyAnswer filters candidates only when an option supplies codes', () => {
  assert.deepEqual(logic.applyAnswer(candidates, { label: '玻璃', codes: ['9617001100'] }), [candidates[0]]);
  assert.deepEqual(logic.applyAnswer(candidates, { label: '我不清楚这项', codes: [] }), candidates);
});

test('candidateConcentration groups remaining candidates by four-digit heading', () => {
  assert.equal(logic.candidateConcentration(candidates), 2 / 3);
  assert.equal(logic.candidateConcentration([]), 0);
});

test('shouldStopConfirm applies convergence, question cap and consecutive unknown rules', () => {
  const unknown = attr => ({ attr, answer: '我不清楚这项', freeText: '' });
  assert.equal(logic.shouldStopConfirm({ remaining: [candidates[0]], answers: [], answeredCount: 1 }), true);
  assert.equal(logic.shouldStopConfirm({ remaining: candidates, answers: [], answeredCount: 1 }), true);
  assert.equal(logic.shouldStopConfirm({ remaining: candidates.slice(1), answers: [], answeredCount: 3 }), true);
  assert.equal(logic.shouldStopConfirm({ remaining: candidates.slice(1), answers: [unknown('材质'), unknown('功率')], answeredCount: 2 }), true);
  assert.equal(logic.shouldStopConfirm({
    remaining: candidates.slice(1),
    answers: [unknown('材质'), { attr: '结构', answer: '以上都不是（我补充说明）', freeText: '' }],
    answeredCount: 2
  }), false);
});
