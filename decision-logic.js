(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HSDecision = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatCode(digits) {
    const value = String(digits || '').replace(/\D/g, '');
    if (value.length === 10) return value.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4');
    if (value.length === 6) return value.replace(/(\d{4})(\d{2})/, '$1.$2');
    if (value.length === 4) return value;
    return value;
  }

  function getStoredClassificationResult(record) {
    const result = record && record.result;
    const p2 = result && result.p2;
    const hs = p2 && p2.hs;
    return hs && /^\d{10}$/.test(String(hs.code || p2.selectedCode || '')) ? result : null;
  }

  function shouldPersistRecord(record) {
    if (!record || record.mode !== 'classify') return true;
    return record.status === '已完成' && !!getStoredClassificationResult(record);
  }

  function buildLegacyClassificationResult(record, hs) {
    if (!hs) return null;
    return {
      legacy: true,
      p1: { productName: record.name || record.input || hs.name, knownAttrs: [] },
      p2: {
        selectedCode: hs.code || record.code,
        hs,
        reasons: [
          '历史记录：这条旧记录只保存了最终编码，未保存当时的完整归类理由，页面不会用其他商品的模板代替。',
          '编码核验：当前税则数据库中存在该编码，商品名称、税率、监管条件和申报要素均按当前数据库展示。'
        ],
        counterfactuals: [],
        alternatives: [],
        unconfirmed: ['原始归类理由与候选比较信息'],
        legalReferences: [],
        complianceNotices: []
      },
      answers: []
    };
  }

  function buildClassificationPath(result) {
    const p1 = (result && result.p1) || {};
    const p2 = (result && result.p2) || {};
    const hs = p2.hs || {};
    const digits = String(hs.code || p2.selectedCode || '').replace(/\D/g, '');
    if (digits.length !== 10) return { nodes: [], sourceNote: '暂无可展示的完整归类路径' };

    const reasons = Array.isArray(p2.reasons) ? p2.reasons.filter(Boolean) : [];
    const alternatives = Array.isArray(p2.alternatives) ? p2.alternatives.filter(Boolean) : [];
    const legalReferences = Array.isArray(p2.legalReferences) ? p2.legalReferences.filter(Boolean) : [];
    const productName = p1.productName || hs.name || '该商品';
    const alternative = alternatives[0];
    const excluded = alternative
      ? '已排除分支：' + (alternative.codeDisplay || formatCode(alternative.code))
        + (alternative.name ? ' · ' + alternative.name : '')
        + ' —— ' + (alternative.whyNot || '与已确认的商品属性不符')
      : '';

    const nodes = [
      {
        code: digits.slice(0, 2),
        title: '第 ' + Number(digits.slice(0, 2)) + ' 章 · ' + (hs.chapter || '所属章节'),
        description: reasons[0] || productName + '按商品属性和税目条文定位到本章。'
      },
      {
        code: digits.slice(0, 4),
        title: '品目 ' + digits.slice(0, 2) + '.' + digits.slice(2, 4),
        description: hs.note || reasons[0] || '所选编码属于该品目。'
      },
      {
        code: formatCode(digits.slice(0, 6)),
        title: '子目 ' + formatCode(digits.slice(0, 6)),
        description: reasons[1] || '根据已确认的商品属性继续收窄到该子目。',
        excluded
      },
      {
        code: hs.codeDisplay || formatCode(digits),
        title: '本国子目 · ' + (hs.name || productName),
        description: reasons[2] || reasons[reasons.length - 1] || '最终选择与商品描述及已确认属性一致。',
        final: true
      }
    ];

    const sources = [...new Set(legalReferences.map(item => item.sourceTitle).filter(Boolean))];
    const sourceLabel = sources.length ? sources.join(' · ') : '海关税则数据库';
    const version = hs.dataVersion ? '（数据版本 ' + hs.dataVersion + '）' : '';
    return { nodes, sourceNote: '路径依据：' + sourceLabel + version };
  }

  return {
    buildClassificationPath,
    buildLegacyClassificationResult,
    getStoredClassificationResult,
    shouldPersistRecord
  };
});
