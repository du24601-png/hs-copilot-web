const test = require('node:test');
const assert = require('node:assert/strict');

let logic = {};
try {
  logic = require('../decision-logic.js');
} catch (error) {
  logic.__loadError = error;
}

const ginsengResult = {
  p1: {
    productName: '人参',
    knownAttrs: [{ key: '形态', value: '鲜或干' }]
  },
  p2: {
    selectedCode: '1211202110',
    hs: {
      code: '1211202110',
      codeDisplay: '1211.20.21.10',
      name: '鲜或干的野生人参（仅限俄罗斯种群，西洋参除外）',
      chapter: '含油子仁及果实；杂项子仁及果实；工业用或药用植物',
      note: '不论是否切割、压碎或研磨成粉',
      declareElements: ['品名', '用途'],
      rates: { mfn: 0, vat: 0.09 },
      regConditions: [],
      dataVersion: '2026-08-23'
    },
    reasons: [
      '主要功能：商品为人参，属于税目12.11项下的药用植物',
      '形态：用户确认商品为野生，且为鲜或干',
      '用途：用户明确为俄罗斯种群'
    ],
    counterfactuals: [
      { condition: '如果商品不是野生而是林下山参', advice: '考虑其他子目' }
    ],
    alternatives: [
      { code: '1211202190', codeDisplay: '1211.20.21.90', whyNot: '俄罗斯种群除外' }
    ],
    unconfirmed: [],
    legalReferences: [{ sourceTitle: '中华人民共和国进出口税则', title: '归类总规则一' }]
  },
  answers: [{ attr: '关键确认', answer: '以上都不是（我补充说明）', freeText: '野生，俄罗斯种群，鲜或干' }]
};

test('ginseng classification path is derived from the selected result, not the stylus template', () => {
  assert.equal(typeof logic.buildClassificationPath, 'function');
  const path = logic.buildClassificationPath(ginsengResult);
  assert.deepEqual(path.nodes.map(node => node.code), [
    '12', '1211', '1211.20', '1211.20.21.10'
  ]);
  const renderedText = JSON.stringify(path);
  assert.match(renderedText, /人参/);
  assert.match(renderedText, /俄罗斯种群/);
  assert.doesNotMatch(renderedText, /9608|触控笔|圆珠笔/);
});

test('completed classification history restores the exact stored decision snapshot', () => {
  assert.equal(typeof logic.getStoredClassificationResult, 'function');
  const restored = logic.getStoredClassificationResult({
    id: 'ginseng-complete', mode: 'classify', status: '已完成', result: ginsengResult
  });
  assert.deepEqual(restored, ginsengResult);
});

test('classification history is persisted only after a complete decision snapshot exists', () => {
  assert.equal(typeof logic.shouldPersistRecord, 'function');
  assert.equal(logic.shouldPersistRecord({
    id: 'ginseng-pending', mode: 'classify', status: '待确认', code: '1211202110'
  }), false);
  assert.equal(logic.shouldPersistRecord({
    id: 'ginseng-complete', mode: 'classify', status: '已完成', result: ginsengResult
  }), true);
  assert.equal(logic.shouldPersistRecord({
    id: 'verify-complete', mode: 'verify', status: '已完成', code: '1211202110'
  }), true);
});

test('legacy history without a result snapshot produces an honest database-backed summary', () => {
  assert.equal(typeof logic.buildLegacyClassificationResult, 'function');
  const legacy = logic.buildLegacyClassificationResult({
    input: '人参', name: '人参', code: '1211202110', codeDisplay: '1211.20.21.10'
  }, ginsengResult.p2.hs);
  assert.equal(legacy.p2.selectedCode, '1211202110');
  assert.equal(legacy.p2.hs.name, ginsengResult.p2.hs.name);
  assert.deepEqual(legacy.p2.counterfactuals, []);
  assert.deepEqual(legacy.p2.alternatives, []);
  assert.match(legacy.p2.reasons.join(''), /未保存当时的完整归类理由/);
  assert.doesNotMatch(JSON.stringify(legacy), /9608|触控笔|圆珠笔/);
});
