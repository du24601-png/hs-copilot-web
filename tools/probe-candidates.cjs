// tools/probe-candidates.cjs —— 候选集命中率探针
// 用法: node tools/probe-candidates.cjs "不锈钢真空保温杯 500ml" "实木蓝牙音箱" "电动牙刷"
const EXPECT = {
  '不锈钢真空保温杯 500ml': '9617',
  '实木蓝牙音箱': '8518',
  '电动牙刷': '8509',
  '铝合金 iPad 触控笔': '9608'
};
const QUERIES = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXPECT);

(async () => {
  let pass = 0;
  for (const q of QUERIES) {
    let d;
    try {
      const r = await fetch('http://127.0.0.1:7100/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q })
      });
      d = await r.json();
    } catch (e) {
      console.log('\n=== ' + q + ' ===\n请求失败: ' + e.message + '（服务起来了吗？）');
      continue;
    }
    const list = d.candidates || [];
    const want = EXPECT[q];
    const idx = want ? list.findIndex(c => c.code.startsWith(want)) : -1;
    const ok = want ? idx >= 0 && idx < 3 : null;
    if (ok) pass++;
    console.log('\n=== ' + q + ' ===');
    console.log(want
      ? (idx >= 0 ? `结果: 命中 #${idx + 1}（期望前缀 ${want}，需进前 3）${ok ? ' [PASS]' : ' [位置不达标]'}`
                  : `结果: 未命中（期望前缀 ${want}） [FAIL]`)
      : '结果: 无期望值，仅打印候选');
    console.log('productName: ' + (d.productName || '-') + ' | confidence: ' + (d.confidence || '-') + ' | converged: ' + (d.converged === undefined ? '-' : d.converged));
    list.forEach((c, i) => console.log(String(i + 1).padStart(2) + '. ' + c.code + '  ' + c.name));
  }
  console.log(`\n---- 汇总: ${pass}/${QUERIES.filter(q => EXPECT[q]).length} 个已知案例进前 3 ----`);
})();
