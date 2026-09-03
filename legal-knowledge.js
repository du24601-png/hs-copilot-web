// Read-only legal knowledge repository for the 2026 Chinese tariff database.
// It scopes authoritative rules locally; it never calls an LLM or invents codes.

const SOURCE_ID = 'cn_tariff_2026';
const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_SCOPED = 24;

const uniq = values => [...new Set(values.filter(Boolean))];

function emptyContext(maxChars = DEFAULT_MAX_CHARS) {
  return {
    available: false,
    source: null,
    griRules: [],
    scopedClauses: [],
    complianceNotices: [],
    allowedRuleIds: [],
    truncated: false,
    maxChars,
    promptText: ''
  };
}

function hasTables(db) {
  try {
    const required = new Set(['legal_source', 'tariff_scope', 'legal_rule', 'legal_rule_scope', 'legal_clause']);
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'legal_%' OR name='tariff_scope')"
    ).all();
    for (const row of rows) required.delete(row.name);
    return required.size === 0;
  } catch {
    return false;
  }
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function normalizeTerms(query, profile, candidates) {
  const values = [
    query,
    profile && profile.core_product,
    profile && profile.function,
    profile && profile.structure,
    profile && profile.usage,
    ...((profile && profile.materials) || []),
    ...((profile && profile.search_terms) || []),
    ...((profile && profile.hs_synonyms) || []),
    ...candidates.map(candidate => candidate.name)
  ];
  const terms = [];
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (value.length >= 2 && value.length <= 20) terms.push(value.toLowerCase());
    for (const run of (value.match(/[一-鿿]{2,12}/g) || [])) {
      terms.push(run.toLowerCase());
      if (run.length > 4) {
        for (let i = 0; i + 4 <= run.length; i++) terms.push(run.slice(i, i + 4).toLowerCase());
      }
    }
  }
  return uniq(terms).slice(0, 40);
}

function scoreClause(item, terms, targetSets) {
  const base = {
    national_subheading_note: 1000,
    chapter_note: 300,
    section_note: 200
  }[item.ruleType] || 0;
  const haystack = (item.title + '\n' + item.text).toLowerCase();
  let score = base;
  for (const term of terms) {
    if (haystack.includes(term)) score += Math.min(60, 12 + term.length * 5);
  }
  if (item.effectType === 'excludes' || item.effectType === 'redirects') score += 30;
  for (const relation of item.relations) {
    if (relation.targetType === 'heading' && targetSets.headings.has(relation.targetRef)) score += 250;
    if (relation.targetType === 'subheading8' && targetSets.subheadings.has(relation.targetRef)) score += 300;
    if (relation.targetType === 'chapter' && targetSets.chapters.has(relation.targetRef)) score += 180;
    if (relation.targetType === 'section' && targetSets.sections.has(relation.targetRef)) score += 120;
  }
  return score;
}

function compactText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function renderContext(context) {
  if (!context.available) return '';
  const source = context.source;
  const lines = [
    '【数据库检索到的权威规则上下文】',
    `来源：${source.documentTitle}；版本：${source.edition}；source_id=${source.sourceId}`,
    '使用要求：按税目条文及类注、章注优先判断；本国子目注释用于对应8位子目边界；只能引用下列rule_id。合规提示不在本段，不能作为选码依据。'
  ];
  for (const rule of context.griRules) {
    lines.push(`\n[GRI][${rule.ruleId}] ${rule.title}\n${rule.text}`);
  }
  for (const clause of context.scopedClauses) {
    const scopes = clause.scopeRefs.join(',');
    lines.push(`\n[适用规则][${clause.ruleId}][${clause.ruleType}][${scopes}] ${clause.title}\n${clause.text}`);
  }
  return lines.join('\n');
}

function fitPrompt(context) {
  let prompt = renderContext(context);
  while (prompt.length > context.maxChars && context.scopedClauses.length) {
    context.scopedClauses.pop();
    context.truncated = true;
    prompt = renderContext(context);
  }
  if (prompt.length > context.maxChars) {
    prompt = prompt.slice(0, context.maxChars - 1) + '…';
    context.truncated = true;
  }
  context.allowedRuleIds = uniq([
    ...context.griRules.map(rule => rule.ruleId),
    ...context.scopedClauses.map(clause => clause.ruleId)
  ]);
  context.promptText = prompt;
  return context;
}

function publicReferences(context, appliedRuleIds) {
  if (!context || !context.available) return [];
  const allowed = new Set(context.allowedRuleIds);
  const requested = uniq((Array.isArray(appliedRuleIds) ? appliedRuleIds : []).map(String))
    .filter(ruleId => allowed.has(ruleId));
  const records = [...context.griRules, ...context.scopedClauses];
  const byId = new Map();
  for (const record of records) if (!byId.has(record.ruleId)) byId.set(record.ruleId, record);
  return requested.map(ruleId => {
    const record = byId.get(ruleId);
    return {
      ruleId,
      ruleType: record.ruleType,
      title: record.title,
      scopeRefs: record.scopeRefs || ['global:*'],
      sourceId: context.source.sourceId,
      sourceTitle: context.source.documentTitle,
      pdfPage: record.pdfPage || null,
      printPage: record.printPage || null,
      excerpt: compactText(record.text)
    };
  });
}

function publicNotices(context) {
  if (!context || !context.available) return [];
  return context.complianceNotices.map(notice => ({
    ruleId: notice.ruleId,
    title: notice.title,
    scopeRefs: notice.scopeRefs,
    sourceId: context.source.sourceId,
    sourceTitle: context.source.documentTitle,
    text: notice.text
  }));
}

function createLegalKnowledgeRepository(db) {
  const available = !!db && hasTables(db);

  function queryForCandidates(query, profile, rawCandidates, options = {}) {
    const maxChars = Math.max(8000, Number(options.maxChars) || DEFAULT_MAX_CHARS);
    const maxScopedClauses = Math.max(1, Number(options.maxScopedClauses) || DEFAULT_MAX_SCOPED);
    if (!available) return emptyContext(maxChars);

    const candidates = (Array.isArray(rawCandidates) ? rawCandidates : [])
      .map(candidate => ({ ...candidate, code: String(candidate && candidate.code || '').replace(/\D/g, '') }))
      .filter(candidate => candidate.code.length === 10);
    const subheadings = uniq(candidates.map(candidate => candidate.code.slice(0, 8)));
    const chapters = uniq(candidates.map(candidate => candidate.code.slice(0, 2)));
    const headings = uniq(candidates.map(candidate => candidate.code.slice(0, 4)));

    const sourceRow = db.prepare(
      'SELECT source_id,document_title,edition,source_sha256 FROM legal_source WHERE source_id=?'
    ).get(SOURCE_ID);
    if (!sourceRow) return emptyContext(maxChars);

    const source = {
      sourceId: sourceRow.source_id,
      documentTitle: sourceRow.document_title,
      edition: sourceRow.edition,
      sourceSha256: sourceRow.source_sha256
    };
    const griRules = db.prepare(
      `SELECT rule_id,rule_type,title,full_text,pdf_page,print_page
       FROM legal_rule
       WHERE source_id=? AND rule_type='gri' AND decision_eligible=1 AND status='active'
       ORDER BY ordinal`
    ).all(SOURCE_ID).map(row => ({
      ruleId: row.rule_id,
      ruleType: row.rule_type,
      title: row.title,
      text: row.full_text,
      scopeRefs: ['global:*'],
      pdfPage: row.pdf_page,
      printPage: row.print_page
    }));

    let sections = [];
    if (chapters.length) {
      sections = uniq(db.prepare(
        `SELECT parent_scope_ref FROM tariff_scope
         WHERE source_id=? AND scope_type='chapter' AND scope_ref IN (${placeholders(chapters)})`
      ).all(SOURCE_ID, ...chapters).map(row => row.parent_scope_ref));
    }

    const conditions = [];
    const scopeParams = [SOURCE_ID];
    if (subheadings.length) {
      conditions.push(`(s.scope_type='subheading8' AND s.scope_ref IN (${placeholders(subheadings)}))`);
      scopeParams.push(...subheadings);
    }
    if (chapters.length) {
      conditions.push(`(s.scope_type='chapter' AND s.scope_ref IN (${placeholders(chapters)}))`);
      scopeParams.push(...chapters);
    }
    if (sections.length) {
      conditions.push(`(s.scope_type='section' AND s.scope_ref IN (${placeholders(sections)}))`);
      scopeParams.push(...sections);
    }

    let scopedRows = [];
    if (conditions.length) {
      scopedRows = db.prepare(
        `SELECT c.clause_id,c.rule_id,c.clause_order,c.clause_text,c.effect_type,
                r.rule_type,r.title,r.pdf_page,r.print_page,s.scope_type,s.scope_ref
         FROM legal_clause c
         JOIN legal_rule r ON r.rule_id=c.rule_id
         JOIN legal_rule_scope s ON s.rule_id=r.rule_id
         WHERE r.source_id=? AND r.decision_eligible=1 AND r.status='active'
           AND (${conditions.join(' OR ')})
         ORDER BY r.ordinal,c.clause_order`
      ).all(...scopeParams);
    }

    const byClause = new Map();
    for (const row of scopedRows) {
      let item = byClause.get(row.clause_id);
      if (!item) {
        item = {
          clauseId: row.clause_id,
          ruleId: row.rule_id,
          ruleType: row.rule_type,
          title: row.title,
          text: row.clause_text,
          effectType: row.effect_type,
          clauseOrder: row.clause_order,
          scopeRefs: [],
          relations: [],
          pdfPage: row.pdf_page,
          printPage: row.print_page
        };
        byClause.set(row.clause_id, item);
      }
      item.scopeRefs.push(`${row.scope_type}:${row.scope_ref}`);
    }

    const clauseIds = [...byClause.keys()];
    if (clauseIds.length) {
      const relationRows = db.prepare(
        `SELECT clause_id,relation_type,target_type,target_ref
         FROM legal_relation WHERE clause_id IN (${placeholders(clauseIds)})`
      ).all(...clauseIds);
      for (const row of relationRows) {
        const item = byClause.get(row.clause_id);
        if (item) item.relations.push({
          relationType: row.relation_type,
          targetType: row.target_type,
          targetRef: row.target_ref
        });
      }
    }

    const terms = normalizeTerms(query, profile || {}, candidates);
    const targetSets = {
      subheadings: new Set(subheadings),
      chapters: new Set(chapters),
      headings: new Set(headings),
      sections: new Set(sections)
    };
    const ranked = [...byClause.values()]
      .map(item => ({ ...item, score: scoreClause(item, terms, targetSets) }))
      .sort((a, b) => b.score - a.score || a.ruleId.localeCompare(b.ruleId) || a.clauseOrder - b.clauseOrder);

    // Exact national notes are never displaced. Then cover every applicable
    // chapter/section rule once before filling remaining slots by score.
    const selected = [];
    const selectedIds = new Set();
    for (const item of ranked.filter(item => item.ruleType === 'national_subheading_note')) {
      selected.push(item);
      selectedIds.add(item.clauseId);
    }
    const bestByRule = new Map();
    for (const item of ranked.filter(item => item.ruleType !== 'national_subheading_note')) {
      if (!bestByRule.has(item.ruleId)) bestByRule.set(item.ruleId, item);
    }
    for (const item of [...bestByRule.values()].sort((a, b) => b.score - a.score)) {
      if (selected.length >= maxScopedClauses) break;
      selected.push(item);
      selectedIds.add(item.clauseId);
    }
    for (const item of ranked) {
      if (selected.length >= maxScopedClauses) break;
      if (selectedIds.has(item.clauseId)) continue;
      selected.push(item);
      selectedIds.add(item.clauseId);
    }

    let complianceNotices = [];
    if (subheadings.length) {
      complianceNotices = db.prepare(
        `SELECT DISTINCT r.rule_id,r.rule_type,r.title,r.full_text,s.scope_type,s.scope_ref
         FROM legal_rule r
         JOIN legal_rule_scope s ON s.rule_id=r.rule_id
         WHERE r.source_id=? AND r.rule_type='compliance_notice' AND r.status='active'
           AND s.scope_type='subheading8' AND s.scope_ref IN (${placeholders(subheadings)})
         ORDER BY r.ordinal`
      ).all(SOURCE_ID, ...subheadings).map(row => ({
        ruleId: row.rule_id,
        ruleType: row.rule_type,
        title: row.title,
        text: row.full_text,
        scopeRefs: [`${row.scope_type}:${row.scope_ref}`]
      }));
    }

    return fitPrompt({
      available: true,
      source,
      griRules,
      scopedClauses: selected,
      complianceNotices,
      allowedRuleIds: [],
      truncated: ranked.length > selected.length,
      maxChars,
      promptText: ''
    });
  }

  // B（归类依据增强）：针对选中编码，从现有数据库主动检索最具体的依据——
  // ① 该 8 位子目的本国子目注释；② 本品目所属章的章注中点名该品目(如"85.17")的条款。
  // 不依赖 LLM 引用的 appliedRuleIds，避免结果页只显示泛泛的 GRI 总规则。
  function queryCodeBasis(selectedCode) {
    const code = String(selectedCode || '').replace(/\D/g, '');
    if (!available || code.length !== 10) return [];
    const chapter = code.slice(0, 2), heading = code.slice(0, 4), sub8 = code.slice(0, 8);
    const pat = chapter + '.' + heading.slice(2); // 如 "85.17"
    const basis = [];
    try {
      const nat = db.prepare(
        `SELECT r.rule_id,r.title,r.full_text,r.print_page,r.pdf_page
         FROM legal_rule r JOIN legal_rule_scope s ON s.rule_id=r.rule_id
         WHERE r.source_id=? AND r.rule_type='national_subheading_note' AND r.status='active'
           AND s.scope_type='subheading8' AND s.scope_ref=?`).all(SOURCE_ID, sub8);
      for (const n of nat) basis.push({ kind: 'national_subheading_note', label: '本国子目注释', ruleId: n.rule_id, title: n.title, text: n.full_text, printPage: n.print_page, pdfPage: n.pdf_page });
    } catch { /* 表缺失或查询异常，忽略 */ }
    try {
      const chm = db.prepare(
        `SELECT DISTINCT c.rule_id,c.clause_text,r.title,r.print_page,r.pdf_page
         FROM legal_clause c JOIN legal_rule r ON r.rule_id=c.rule_id JOIN legal_rule_scope s ON s.rule_id=r.rule_id
         WHERE r.source_id=? AND r.rule_type='chapter_note' AND r.status='active'
           AND s.scope_type='chapter' AND s.scope_ref=? AND c.clause_text LIKE ?`).all(SOURCE_ID, chapter, '%' + pat + '%');
      for (const c of chm) basis.push({ kind: 'chapter_note', label: '章注·第' + Number(chapter) + '章', ruleId: c.rule_id, title: c.title, text: c.clause_text, printPage: c.print_page, pdfPage: c.pdf_page });
    } catch { /* 忽略 */ }
    return basis;
  }

  return { available, queryForCandidates, queryCodeBasis };
}

function formatLegalContext(context) {
  return context && context.promptText ? context.promptText : '';
}

module.exports = {
  createLegalKnowledgeRepository,
  emptyContext,
  formatLegalContext,
  publicReferences,
  publicNotices
};
