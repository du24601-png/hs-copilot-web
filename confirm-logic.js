(function exposeConfirmLogic(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HSConfirm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createConfirmLogic() {
  'use strict';

  function optionLabel(option) {
    return String(option && (option.label || option.answer) || option || '');
  }

  function isUnknownAnswer(answer) {
    return /不确定|我不清楚这项/.test(optionLabel(answer));
  }

  function isFreeTextAnswer(answer) {
    return /^以上都不是/.test(optionLabel(answer));
  }

  function normalizeOption(option) {
    if (option && typeof option === 'object') {
      const label = optionLabel(option);
      return {
        label,
        codes: isUnknownAnswer(label) || isFreeTextAnswer(label)
          ? []
          : (Array.isArray(option.codes) ? option.codes : []).map(String)
      };
    }
    return { label: String(option || ''), codes: [] };
  }

  function applyAnswer(candidates, option) {
    const normalized = normalizeOption(option);
    if (!normalized.codes.length) return candidates.slice();
    const keep = new Set(normalized.codes);
    return candidates.filter(candidate => keep.has(candidate.code));
  }

  function candidateConcentration(candidates) {
    if (!candidates.length) return 0;
    const byHeading = new Map();
    for (const candidate of candidates) {
      const heading = String(candidate.code || '').slice(0, 4);
      byHeading.set(heading, (byHeading.get(heading) || 0) + 1);
    }
    return Math.max(...byHeading.values()) / candidates.length;
  }

  function freeTextForOption(option, draft) {
    return isFreeTextAnswer(option) ? String(draft || '').slice(0, 200) : '';
  }

  function shouldStopConfirm({ remaining, answers, answeredCount, maxQuestions = 3 }) {
    if (remaining.length <= 1) return true;
    if (candidateConcentration(remaining) >= 0.6) return true;
    if (answeredCount >= maxQuestions) return true;
    const answered = (answers || []).filter(Boolean);
    return answered.length >= 2
      && isUnknownAnswer(answered[answered.length - 1])
      && isUnknownAnswer(answered[answered.length - 2]);
  }

  return {
    normalizeOption,
    applyAnswer,
    candidateConcentration,
    isUnknownAnswer,
    isFreeTextAnswer,
    freeTextForOption,
    shouldStopConfirm
  };
});
