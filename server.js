// HS Copilot 零依赖服务器：静态文件 + SQLite 只读 API
// 用法: npm run dev -- --port 7100   或   node server.js --port 7100 --host 127.0.0.1
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith('--' + name + '='));
  if (eq) return eq.split('=')[1];
  return fallback;
}
const PORT = Number(arg('port', process.env.PORT || 7100));
const HOST = arg('host', process.env.HOST || '127.0.0.1');

/* ---------- 数据层：只读连接 2026 税则库 ---------- */
// 优先用项目内的 hs_copilot.db（自包含），其次回退到上级目录
const DB_CANDIDATES = [path.join(__dirname, 'hs_copilot.db'), path.join(__dirname, '..', 'hs_copilot.db')];
const DB_PATH = DB_CANDIDATES.find(p => fs.existsSync(p));
let db = null;
if (DB_PATH) {
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  console.log('[db] 已连接 ' + DB_PATH);
} else {
  console.warn('[db] 未找到 hs_copilot.db，API 将返回 503');
}

const fmtCode = digits => digits.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4');

function getHsRow(digits) {
  const row = db.prepare(
    'SELECT code,name,note,reg_conditions,rate_general,rate_mfn,rate_export,rate_excise,rate_vat FROM hs_code WHERE code=?'
  ).get(digits);
  if (!row) return null;
  const elements = db.prepare('SELECT seq,element FROM declare_element WHERE code=? ORDER BY seq').all(digits);
  // 监管条件字母 -> 证件名称
  const reg = (row.reg_conditions || '').split('').map(ch => {
    const d = db.prepare('SELECT name FROM ref_reg_doc WHERE code=?').get(ch);
    return { code: ch, name: d ? d.name : ch };
  });
  const chapter = db.prepare('SELECT name FROM hs_chapter WHERE chapter=?').get(digits.slice(0, 2));
  return {
    code: row.code,
    codeDisplay: fmtCode(row.code),
    name: row.name,
    note: row.note,
    chapter: chapter ? chapter.name : null,
    rates: { general: row.rate_general, mfn: row.rate_mfn, export: row.rate_export, excise: row.rate_excise, vat: row.rate_vat },
    regConditions: reg,
    declareElements: elements.map(e => e.element),
    dataVersion: '2026-08-23',
    source: '海关总署'
  };
}

// GET /api/hs/9608992000 或 /api/hs/9608.99.20.00
function apiHsCode(res, raw) {
  if (!db) return send(res, 503, { error: '数据库未连接' });
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length !== 10) return send(res, 400, { error: '编码需为 10 位数字' });
  const row = getHsRow(digits);
  if (!row) return send(res, 404, { error: '编码不存在', code: digits });
  send(res, 200, row);
}

// GET /api/search?q=触控笔 | 圆珠笔 | 9608
function apiSearch(res, q) {
  if (!db) return send(res, 503, { error: '数据库未连接' });
  q = (q || '').trim();
  if (!q) return send(res, 400, { error: '缺少关键词' });
  let rows;
  if (/^\d{2,10}$/.test(q)) {
    // 数字前缀：查不到就逐级缩短（HS 版本更迭后旧前缀可能失效，如 851770 → 851779）
    const stmt = db.prepare('SELECT code,name FROM hs_code WHERE code LIKE ? ORDER BY code LIMIT 20');
    for (let p = q; p.length >= 4; p = p.slice(0, -1)) {
      rows = stmt.all(p + '%');
      if (rows.length) break;
    }
    if (!rows || !rows.length) rows = [];
  } else if (q.length >= 3) {
    rows = db.prepare("SELECT code,name FROM hs_fts WHERE hs_fts MATCH ? LIMIT 20").all('"' + q.replace(/"/g, '') + '"');
  } else {
    rows = db.prepare('SELECT code,name FROM hs_code WHERE name LIKE ? LIMIT 20').all('%' + q + '%');
  }
  send(res, 200, { results: rows.map(r => ({ code: r.code, codeDisplay: fmtCode(r.code), name: r.name })) });
}

/* ================= LLM 归类链路 =================
   原则：候选编码、品名、注释、税率、申报要素全部来自 SQLite；
   大模型只做两件事——从描述抽取已知属性、基于真实候选的分歧点生成确认问题。
   LLM 输出中不允许出现任何税率/编码数值，结论编码必须能在候选列表中找到。 */
// 配置优先级：环境变量 > llm.config.json > 内置默认
const LLM_FILE = path.join(__dirname, 'llm.config.json');
let LLM_FILE_CFG = {};
try { LLM_FILE_CFG = JSON.parse(fs.readFileSync(LLM_FILE, 'utf-8')); } catch { /* 无配置文件 */ }
// 多通道：按 llm.config.json 的 providers 顺序尝试（DeepSeek → OpenCode），Kimi 网关兜底
const LLM_PROVIDERS = [];
if (Array.isArray(LLM_FILE_CFG.providers)) {
  for (const p of LLM_FILE_CFG.providers)
    if (p && p.apiKey) LLM_PROVIDERS.push({ base: p.baseUrl, key: p.apiKey, models: p.models || [] });
} else if (process.env.LLM_API_KEY || LLM_FILE_CFG.apiKey) {
  LLM_PROVIDERS.push({
    base: process.env.LLM_BASE_URL || LLM_FILE_CFG.baseUrl || 'https://opencode.ai/zen/v1',
    key: process.env.LLM_API_KEY || LLM_FILE_CFG.apiKey,
    models: LLM_FILE_CFG.models || ['mimo-v2.5-free', 'nemotron-3.5-lightning-free']
  });
}
if (process.env.KIMI_AGENT_GW_KEY) LLM_PROVIDERS.push({
  base: 'https://agent-gw.kimi.com/coding/v1', key: process.env.KIMI_AGENT_GW_KEY,
  models: ['kimi-k2-0905-preview']
});
const LLM_KEY = LLM_PROVIDERS.length ? 'configured' : '';

// 从商品描述检索候选编码：中文按 n-gram + 单字拆分，对品名做 LIKE 打分；
// extraKws 为查询扩展词（近义词/上位词，来自 LLM）；命中数太多的词降权（IDF 思路）
function retrieveCandidates(query, extraKws = []) {
  const runs = query.match(/[一-鿿]+/g) || [];
  // 中心词：最后一个中文段的最后 1-2 字（触控笔→笔）——决定商品大类，大幅加权
  const lastRun = runs[runs.length - 1] || '';
  const headChars = lastRun ? [lastRun.slice(-1), lastRun.slice(-2)] : [];

  const score = new Map();
  const stmt = db.prepare('SELECT code,name FROM hs_code WHERE name LIKE ? LIMIT 60');
  const hitsCache = new Map();
  const hitsOf = kw => {
    if (!hitsCache.has(kw)) hitsCache.set(kw, stmt.all('%' + kw + '%'));
    return hitsCache.get(kw);
  };
  const addRows = (kw, rows, boost, useIdf = true) => {
    const idf = !useIdf ? 1 : rows.length <= 5 ? 3 : rows.length <= 12 ? 1.5 : 0.4;
    const w = (kw.length >= 2 ? kw.length : 0.4) * idf * boost;
    for (const r of rows) {
      // 品名以关键词结尾的（圆珠笔、画笔）比关键词夹在中间的（笔记本）更像该类商品
      const posBonus = r.name.endsWith(kw) ? 2 : 1;
      score.set(r.code, (score.get(r.code) || 0) + w * posBonus);
    }
  };
  // 每个中文段只取“能命中的最长子串”计一次分，避免子串叠加淹没中心词
  for (const run of runs) {
    let matched = false;
    for (let n = Math.min(4, run.length); n >= 2 && !matched; n--) {
      for (let i = 0; i + n <= run.length; i++) {
        const g = run.slice(i, i + n);
        const rows = hitsOf(g);
        if (rows.length) { addRows(g, rows, 1); matched = true; break; }
      }
    }
  }
  extraKws.forEach(k => { const rows = hitsOf(String(k).trim()); if (rows.length) addRows(String(k).trim(), rows, 1); });
  (query.match(/[a-zA-Z][a-zA-Z0-9-]*/g) || []).forEach(w0 => { const rows = hitsOf(w0.toLowerCase()); if (rows.length) addRows(w0, rows, 1); });
  // 中心词高权：商品大类信号远强于材质/修饰词（如"铝合金"会命中大量原材料编码），中心词不做 IDF 降权
  if (headChars[1] && headChars[1].length === 2) { const rows = hitsOf(headChars[1]); if (rows.length) addRows(headChars[1], rows, 5, false); }
  if (headChars[0]) { const rows = hitsOf(headChars[0]); if (rows.length) addRows(headChars[0], rows, 10, false); }

  // CIQ 俗名表：口语商品名（台灯、耳机）直接映射 HS 编码，命中是强信号（同样按命中数降权）
  const ciqStmt = db.prepare('SELECT DISTINCT hs_code FROM ciq_code WHERE goods_name LIKE ? LIMIT 40');
  const addCiq = kw => {
    const rows = ciqStmt.all('%' + kw + '%');
    if (!rows.length) return;
    const idf = rows.length <= 5 ? 3 : rows.length <= 12 ? 1.5 : 0.4;
    const w = (kw.length >= 2 ? kw.length : 1) * idf * 2;
    for (const r of rows) {
      if (!/^\d{10}$/.test(r.hs_code)) continue;
      score.set(r.hs_code, (score.get(r.hs_code) || 0) + w);
    }
  };
  for (const run of runs) if (run.length >= 2) addCiq(run);
  extraKws.forEach(k => { const k2 = String(k).trim(); if (k2.length >= 2) addCiq(k2); });

  // 按品目（前4位）分组，保证多样性：最强品目全量保留（上限 12，让大模型看到该家族全貌），
  // 其余品目各取前 2，共 4 个品目、最多 16 个候选
  const byHeading = new Map();
  for (const [code, s] of score.entries()) {
    const h = code.slice(0, 4);
    if (!byHeading.has(h)) byHeading.set(h, []);
    byHeading.get(h).push([code, s]);
  }
  const groups = [...byHeading.values()]
    .map(list => list.sort((a, b) => b[1] - a[1]))
    // 按整组总分排序：9608 笔类（12 个编码合计更高）比 9603 画笔更能代表"笔"这个大类
    .sort((a, b) => b.reduce((t, x) => t + x[1], 0) - a.reduce((t, x) => t + x[1], 0))
    .slice(0, 4);
  const picked = groups.flatMap((g, gi) => gi === 0 ? g.slice(0, 12) : g.slice(0, 2));
  return picked.map(([code]) => code).slice(0, 16)
    .map(getHsRow)
    .filter(Boolean);
}

/* 查询规划：让 LLM 把口语描述拆成四层，指导税则库检索。
   与“字面检索”并行发起；失败由调用方回退到纯字面检索结果。 */
const PLAN_SYSTEM = `你是中国海关 HS 归类助手。用户给出一个商品描述（可能是口语化大白话）。
任务：把描述拆解成四层，用于指导税则数据库检索。

四层定义与判定规则：
1. core（核心商品）——这个东西“是什么”，回答“它属于哪一类物品”
   - 判据：去掉所有修饰词后剩下的那个名词
   - 正例：「不锈钢真空保温杯」→核心是「保温杯」，不是「不锈钢」
   - 反例：「铝合金 iPad 触控笔」→核心是「触控笔」，铝合金和 iPad 都不是
2. structure（关键结构）——影响归类的结构/功能特征，如「真空」「折叠」「带电加热」
3. material（材质）——制成材料，如「不锈钢」「实木」「铝合金」
4. params（规格参数）——容量/尺寸/功率/型号。逐项标注 affectsCode：
   - true  = 该参数会影响编码（如冷藏箱按容积分档、电机按功率分档）
   - false = 该参数只用于申报，不影响编码（如保温杯的 500ml）

还要输出：
- core.alt：税则品名中可能出现的同义说法。海关税则用语与口语差异很大，
  例如口语「保温杯」在税则里叫「保温瓶」。请给出 2-4 个税则里可能出现的说法。
- core.chapters：该商品可能所属的 HS 章节号（2 位数字字符串），最多 3 个，
  按可能性排序。税则共 96 章，你给的章节会用于库内兜底检索，宁可多给不要漏给。

只输出 JSON，不要任何解释文字、不要代码块标记：
{"core":{"word":"","alt":[],"chapters":[]},"structure":{"word":""},"material":{"word":""},"params":[{"key":"","value":"","affectsCode":false}],"confidence":"high|medium|low"}`;

function normalizePlan(raw) {
  const root = raw && typeof raw === 'object' ? raw : {};
  return {
    core: {
      word: String((root.core && root.core.word) || '').slice(0, 20),
      alt: (Array.isArray(root.core && root.core.alt) ? root.core.alt : []).map(String).slice(0, 6),
      chapters: (Array.isArray(root.core && root.core.chapters) ? root.core.chapters : [])
        .map(c => String(c).replace(/\D/g, '').slice(0, 2)).filter(c => c.length === 2).slice(0, 3)
    },
    structure: { word: String((root.structure && root.structure.word) || '').slice(0, 20) },
    material: { word: String((root.material && root.material.word) || '').slice(0, 20) },
    params: (Array.isArray(root.params) ? root.params : [])
      .filter(p => p && p.key).slice(0, 6)
      .map(p => ({ key: String(p.key).slice(0, 12), value: String(p.value || '').slice(0, 20), affectsCode: !!p.affectsCode })),
    confidence: ['high', 'medium', 'low'].includes(root.confidence) ? root.confidence : 'low'
  };
}

const planCache = new Map();
async function llmPlan(query) {
  if (planCache.has(query)) return planCache.get(query);
  const messages = [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: '商品：' + query }
  ];
  const { data } = await llmChat(messages, { quick: true });
  const plan = normalizePlan(data);
  planCache.set(query, plan);
  return plan;
}

/* 两阶段 Prompt：
   P1（确认页前）：抽属性 + 出确认问题 + 试探性预选（可空）——信息不足不该拦路，正是确认页存在的意义
   P2（确认页后）：带着用户答案做最终选择，输出理由/反事实/备选 */
const P1_SYSTEM = `你是中国海关 HS 预归类专家助手。用户会给一个商品描述，以及从 2026 年版进出口税则数据库检索到的真实候选编码列表（含品名、注释、申报要素）。
这是流程的第一步：你的任务是为“关键确认”环节做准备，不要急于下结论。
1. productName：商品描述概括成简短商品名（10 字内）。
2. knownAttrs：从描述中抽取已明确提及的属性（材质/用途/品牌/型号/功能等），value 必须来自描述原文，禁止编造。
3. questions：针对“能改变归类结论的关键未知属性”生成 1-2 个确认问题。每个问题 2-3 个互斥选项（最后一个固定为“不确定”），hint 给例子，why 一句话说明为什么要问（该属性区分了哪些候选编码），whyDetail 展开说明涉及的品目、税率或监管差异。如果描述已经足够确定归类，questions 可以为空数组。
4. provisionalCode：当前信息下最可能的候选编码，没有把握就填 null。
5. confidence：high / medium / low。
6. refuse：仅当描述与所有候选都明显无关时为 true 并给 refuseReason；只要有可能相关就为 false——信息不足时应该用 questions 收集信息，而不是拒绝。

只输出严格符合此模板的 JSON 对象，不要输出任何其他文字、不要加代码块标记：
{"productName":"","knownAttrs":[{"key":"属性名","value":"值"}],"questions":[{"attr":"属性名","question":"问题","hint":"例子","options":["选项1","选项2","不确定"],"why":"一句话原因","whyDetail":"展开说明"}],"provisionalCode":"候选中的10位编码或null","confidence":"medium","refuse":false,"refuseReason":""}
所有字段必须出现，没有内容用空数组。`;

const P2_SYSTEM = `你是中国海关 HS 预归类专家助手。用户给了商品描述、补充确认的答案、以及从 2026 年版进出口税则数据库检索到的真实候选编码列表。这是最终归类步骤。
1. selectedCode：综合描述与确认答案，从候选列表中选择最合适的 10 位编码，只能选列表中的 code。候选不完美时也要选相对最合适的一个，把 confidence 设为 medium 或 low，并在 reasons 中说明保留意见；只有商品与全部候选明显毫不相干时，才允许 selectedCode 为 null 且 refuse=true、给出 refuseReason。不允许因为"理想编码不在候选中"而拒答。
2. confidence：high / medium / low。
3. reasons：选择该编码的 3 条理由，格式“维度：说明”，维度如 主要功能/材质/形态/用途，说明要引用用户的确认答案。
4. counterfactuals：1-2 条反事实提示 {condition, advice}，说明什么属性变化会改变结论。
5. alternatives：1-2 个未选候选 {code, whyNot}，说明未选原因。

只输出严格符合此模板的 JSON 对象，不要输出任何其他文字、不要加代码块标记：
{"selectedCode":"候选中的10位编码或null","confidence":"high","reasons":["维度：说明"],"counterfactuals":[{"condition":"如果…","advice":"建议…"}],"alternatives":[{"code":"候选中的10位编码","whyNot":"未选原因"}],"refuse":false,"refuseReason":""}
所有字段必须出现，没有内容用空数组。`;

async function llmCall(provider, model, messages, useJsonMode, timeoutMs = 60000) {
  const body = { model, messages };
  if (useJsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(provider.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    // 通道不支持 json_object 时去掉该参数重试一次
    if (r.status === 400 && useJsonMode && /response_format|json/i.test(t))
      return llmCall(provider, model, messages, false, timeoutMs);
    throw new Error(model + ' 返回 ' + r.status + ' ' + t.slice(0, 120));
  }
  const d = await r.json();
  return d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '';
}

// 依次尝试 通道×模型；429 等待后重试一次；全部失败才抛错
// opts.quick：快速模式（查询扩展用）——只试首个通道、短超时、429 不等待
// 返回 { data, model }：data 为已解析的 JSON 对象（解析失败视为该模型失败，继续下一个）
async function llmChat(messages, opts = {}) {
  const providers = opts.quick ? LLM_PROVIDERS.slice(0, 1) : LLM_PROVIDERS;
  const timeout = opts.quick ? 20000 : 60000;
  let lastErr = null;
  for (const provider of providers) {
    for (const model of provider.models) {
      for (let attempt = 0; attempt < (opts.quick ? 1 : 3); attempt++) {
        try {
          let text = await llmCall(provider, model, messages, true, timeout);
          text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
          let data;
          try { data = JSON.parse(text); }
          catch {
            const i = text.indexOf('{'), j = text.lastIndexOf('}');
            if (i >= 0 && j > i) data = JSON.parse(text.slice(i, j + 1));
            else throw new Error(model + ' 输出不是有效 JSON');
          }
          return { data, model };
        } catch (e) {
          lastErr = e;
          console.warn('[llm]', e.message);
          if (/429/.test(e.message) && attempt < 2 && !opts.quick) {
            await new Promise(r => setTimeout(r, 12000)); // 免费额度按分钟限流，等 12 秒再试
            continue;
          }
          break; // 非限流错误或已重试过 → 下一个模型
        }
      }
    }
  }
  throw lastErr || new Error('所有模型通道均不可用');
}

const candBriefOf = candidates => candidates.map(c => ({
  code: c.code, name: c.name, chapter: c.chapter, note: c.note,
  declareElements: c.declareElements
}));

async function llmPhase1(query, candidates) {
  const messages = [
    { role: 'system', content: P1_SYSTEM },
    { role: 'user', content: '商品描述：' + query + '\n\n候选编码列表（JSON）：\n' + JSON.stringify(candBriefOf(candidates), null, 1) }
  ];
  const { data, model } = await llmChat(messages);
  data.__model = model;
  return data;
}

async function llmPhase2(query, knownAttrs, answers, candidates) {
  const attrText = (knownAttrs || []).map(a => a.key + '：' + a.value).join('；') || '无';
  const ansText = (answers || []).map(a => a.attr + '：' + a.answer).join('；') || '无';
  const messages = [
    { role: 'system', content: P2_SYSTEM },
    { role: 'user', content: '商品描述：' + query + '\n描述中已明确的属性：' + attrText + '\n用户确认的答案：' + ansText + '\n\n候选编码列表（JSON）：\n' + JSON.stringify(candBriefOf(candidates), null, 1) }
  ];
  const { data, model } = await llmChat(messages);
  data.__model = model;
  return data;
}

// P1 输出校验：确认页准备数据（预选编码可空，有问题就继续问，不拦路）
function sanitizePhase1(raw, candidates) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const codes = new Set(candidates.map(c => c.code));
  return {
    productName: String(r.productName || '').slice(0, 30),
    knownAttrs: (Array.isArray(r.knownAttrs) ? r.knownAttrs : [])
      .filter(a => a && a.key && a.value).slice(0, 5)
      .map(a => ({ key: String(a.key).slice(0, 12), value: String(a.value).slice(0, 40) })),
    questions: (Array.isArray(r.questions) ? r.questions : [])
      .filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2).slice(0, 2)
      .map(q => ({
        attr: String(q.attr || q.question).slice(0, 12),
        question: String(q.question).slice(0, 60),
        hint: String(q.hint || '').slice(0, 60),
        options: q.options.slice(0, 3).map(o => String(o).slice(0, 30)),
        why: String(q.why || '').slice(0, 80),
        whyDetail: String(q.whyDetail || q.why || '').slice(0, 200)
      })),
    provisionalCode: codes.has(String(r.provisionalCode || '')) ? String(r.provisionalCode) : null,
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
    refuse: !!r.refuse,
    refuseReason: String(r.refuseReason || '').slice(0, 120)
  };
}

// P2 输出校验：最终结论，编码必须命中候选
function sanitizePhase2(raw, candidates) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const codes = new Set(candidates.map(c => c.code));
  const out = {
    selectedCode: codes.has(String(r.selectedCode || '')) ? String(r.selectedCode) : null,
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
    reasons: (Array.isArray(r.reasons) ? r.reasons : []).slice(0, 3).map(x => String(x).slice(0, 80)),
    counterfactuals: (Array.isArray(r.counterfactuals) ? r.counterfactuals : [])
      .filter(c => c && c.condition).slice(0, 2)
      .map(c => ({ condition: String(c.condition).slice(0, 40), advice: String(c.advice || '需重新评估归类').slice(0, 40) })),
    alternatives: (Array.isArray(r.alternatives) ? r.alternatives : [])
      .filter(a => a && codes.has(String(a.code || ''))).slice(0, 2)
      .map(a => ({ code: String(a.code), whyNot: String(a.whyNot || '').slice(0, 60) })),
    refuse: !!r.refuse,
    refuseReason: String(r.refuseReason || '').slice(0, 120)
  };
  if (!out.selectedCode) { out.refuse = true; if (!out.refuseReason) out.refuseReason = '候选编码均不匹配，无法给出可靠归类'; }
  return out;
}

// 只取 code 数组，便于分层加权合并
function codesFor(text) {
  if (!text) return [];
  return retrieveCandidates(String(text)).map(c => c.code);
}

// 章节兜底：在指定章内按词检索；无词或无命中时取该章前若干条
function codesInChapter(chapter, word) {
  const ch = String(chapter).replace(/\D/g, '').slice(0, 2);
  if (ch.length !== 2) return [];
  if (word) {
    const rows = db.prepare('SELECT code FROM hs_code WHERE code LIKE ? AND name LIKE ? LIMIT 30')
      .all(ch + '%', '%' + word + '%');
    if (rows.length) return rows.map(r => r.code);
  }
  return db.prepare('SELECT code FROM hs_code WHERE code LIKE ? LIMIT 12').all(ch + '%').map(r => r.code);
}

const PLAN_WEIGHT = { base: 2, core: 3, alt: 2, chapter: 1.5, structure: 2, material: 0.5, param: 1 };

function pickDiverseCodes(ranked, limit = 16, perHeadingLimit = 6) {
  const perHeading = new Map();
  const picked = [];
  for (const [code] of ranked) {
    const heading = code.slice(0, 4);
    const count = perHeading.get(heading) || 0;
    if (count >= perHeadingLimit) continue;
    perHeading.set(heading, count + 1);
    picked.push(code);
    if (picked.length >= limit) break;
  }
  return picked;
}

function mergeCandidateCodes(plan, baseCodes, lookupCodes = codesFor, lookupChapterCodes = codesInChapter) {
  const score = new Map();
  const bump = (codes, weight) => (codes || []).forEach((code, index) => {
    if (!code) return;
    score.set(code, (score.get(code) || 0) + weight * (1 - Math.min(index, 20) * 0.02));
  });

  bump(baseCodes, PLAN_WEIGHT.base);
  bump(lookupCodes(plan.core.word), PLAN_WEIGHT.core);
  plan.core.alt.forEach(word => bump(lookupCodes(word), PLAN_WEIGHT.alt));
  plan.core.chapters.forEach(chapter =>
    bump(lookupChapterCodes(chapter, plan.core.word || plan.structure.word), PLAN_WEIGHT.chapter));
  bump(lookupCodes(plan.structure.word), PLAN_WEIGHT.structure);
  bump(lookupCodes(plan.material.word), PLAN_WEIGHT.material);
  plan.params.filter(param => param.affectsCode && param.value)
    .forEach(param => bump(lookupCodes(param.value), PLAN_WEIGHT.param));

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  return { ranked, picked: pickDiverseCodes(ranked) };
}

// 检索候选：AI 四层规划与原始字面检索并行发起，分别检索后加权合并
async function candidatesFor(query) {
  const t0 = Date.now();
  const [plan, base] = await Promise.all([
    llmPlan(query).catch(e => { console.warn('[plan]', e.message); return null; }),
    Promise.resolve(retrieveCandidates(query))
  ]);
  if (!plan) return base;

  const merged = mergeCandidateCodes(plan, base.map(c => c.code));
  console.log('[plan]', JSON.stringify(plan), (Date.now() - t0) + 'ms');
  const rows = merged.picked.map(getHsRow).filter(Boolean);
  return rows.length ? rows : base;
}

const classifyCache = new Map(); // query -> {ts, payload}（P1 结果缓存）
// POST /api/classify —— 阶段一：为关键确认页准备数据
async function apiClassify(res, query) {
  if (process.env.DEV_DELAY) await new Promise(r => setTimeout(r, Number(process.env.DEV_DELAY))); // 演示/测试用延迟
  if (!db) return send(res, 503, { error: '数据库未连接' });
  if (!LLM_KEY) return send(res, 503, { error: '大模型服务未配置' });
  query = String(query || '').trim().slice(0, 200);
  if (!query) return send(res, 400, { error: '缺少商品描述' });

  const hit = classifyCache.get(query);
  if (hit && Date.now() - hit.ts < 86400e3) return send(res, 200, hit.payload);

  try {
    const candidates = await candidatesFor(query);
    if (!candidates.length)
      return send(res, 200, { refuse: true, refuseReason: '数据库中检索不到相关候选编码，请补充更具体的商品描述', candidates: [], questions: [], knownAttrs: [] });
    const raw = await llmPhase1(query, candidates);
    const result = sanitizePhase1(raw, candidates);
    result.candidates = candidates.map(c => ({ code: c.code, codeDisplay: c.codeDisplay, name: c.name }));
    // 预选编码的权威数据从数据库取
    result.provisional = result.provisionalCode ? getHsRow(result.provisionalCode) : null;
    classifyCache.set(query, { ts: Date.now(), payload: result });
    send(res, 200, result);
  } catch (e) {
    console.error('[classify]', e.message);
    send(res, 502, { error: '大模型调用失败：' + e.message });
  }
}

// POST /api/decide —— 阶段二：带着确认答案输出最终归类结论
async function apiDecide(res, body) {
  if (!db) return send(res, 503, { error: '数据库未连接' });
  if (!LLM_KEY) return send(res, 503, { error: '大模型服务未配置' });
  const query = String(body.query || '').trim().slice(0, 200);
  if (!query) return send(res, 400, { error: '缺少商品描述' });
  const knownAttrs = (Array.isArray(body.knownAttrs) ? body.knownAttrs : [])
    .filter(a => a && a.key && a.value).slice(0, 5)
    .map(a => ({ key: String(a.key).slice(0, 12), value: String(a.value).slice(0, 40) }));
  const answers = (Array.isArray(body.answers) ? body.answers : [])
    .filter(a => a && a.attr && a.answer).slice(0, 4)
    .map(a => ({ attr: String(a.attr).slice(0, 12), answer: String(a.answer).slice(0, 60) }));

  try {
    const candidates = await candidatesFor(query); // 检索是确定性的，与阶段一一致
    if (!candidates.length)
      return send(res, 200, { refuse: true, refuseReason: '数据库中检索不到相关候选编码' });
    const raw = await llmPhase2(query, knownAttrs, answers, candidates);
    const result = sanitizePhase2(raw, candidates);
    // 结论编码的权威数据（名称/税率/要素）从数据库取，不采用 LLM 的任何数值
    result.hs = result.selectedCode ? getHsRow(result.selectedCode) : null;
    result.alternatives = result.alternatives.map(a => {
      const row = getHsRow(a.code);
      return { ...a, codeDisplay: row ? row.codeDisplay : a.code, name: row ? row.name : '' };
    });
    send(res, 200, result);
  } catch (e) {
    console.error('[decide]', e.message);
    send(res, 502, { error: '大模型调用失败：' + e.message });
  }
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  // API 路由
  const m = url.pathname.match(/^\/api\/hs\/([\d.]+)$/);
  if (m) return apiHsCode(res, m[1]);
  if (url.pathname === '/api/search') return apiSearch(res, url.searchParams.get('q'));
  if (url.pathname === '/api/classify' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let q = '';
      try { q = JSON.parse(body || '{}').query; } catch { /* 忽略 */ }
      apiClassify(res, q);
    });
    return;
  }
  if (url.pathname === '/api/decide' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
      apiDecide(res, parsed);
    });
    return;
  }
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, db: !!db, llm: !!LLM_KEY });
  // 静态
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function startServer() {
  return http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log(`HS Copilot dev server: http://${HOST}:${PORT}/`);
  });
}

if (require.main === module) startServer();

module.exports = {
  startServer,
  normalizePlan,
  mergeCandidateCodes,
  pickDiverseCodes,
  retrieveCandidates,
  sanitizePhase1,
  sanitizePhase2
};
