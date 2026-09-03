const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const fixturePath = path.join(__dirname, 'fixtures', 'real-products-noisy-20.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

test('real-product fixture contains exactly 20 evidence-backed cases', () => {
  assert.equal(fixture.cases.length, 20);
  assert.equal(new Set(fixture.cases.map(item => item.id)).size, 20);

  for (const item of fixture.cases) {
    assert.match(item.id, /^real-\d{3}$/);
    assert.match(item.expectedCode, /^\d{10}$/);
    assert.match(item.officialCode8, /^\d{8}$/);
    assert.ok(item.expectedCode.startsWith(item.officialCode8), `${item.id}: 10位编码没有继承官方8位号列`);
    assert.ok(item.officialDecisionId);
    assert.doesNotMatch(item.description, new RegExp(item.expectedCode), `${item.id}: 输入泄露了答案`);
    assert.ok(new URL(item.decisionSourceUrl).protocol.startsWith('http'));
    assert.ok(new URL(item.commerceSourceUrl).protocol.startsWith('http'));
  }
});

test('descriptions are long and noisy but stay within the API 200-character limit', () => {
  for (const item of fixture.cases) {
    const length = [...item.description].length;
    assert.ok(length >= 120, `${item.id}: 描述只有 ${length} 字符，不足以模拟冗长输入`);
    assert.ok(length <= 200, `${item.id}: 描述有 ${length} 字符，会被 /api/classify 截断`);
  }
});

test('all expected 10-digit codes exist in the local authoritative database', () => {
  const db = new DatabaseSync(path.join(__dirname, '..', 'hs_copilot.db'), { readOnly: true });
  const find = db.prepare('SELECT code, name FROM hs_code WHERE code = ?');

  try {
    for (const item of fixture.cases) {
      const row = find.get(item.expectedCode);
      assert.ok(row, `${item.id}: 本地库不存在 ${item.expectedCode}`);
      assert.equal(row.code, item.expectedCode);
    }
  } finally {
    db.close();
  }
});
