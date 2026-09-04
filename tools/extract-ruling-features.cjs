#!/usr/bin/env node
// 离线为判例抽取“归类特征档案”(核心品名/材质/功能/结构/用途),写入 ruling_case_feature 表。
// 特征维度与 server.js 的 LLM① 商品理解(UNDERSTAND_SYSTEM)对齐,检索时即可“按商品本质相似度”匹配判例,
// 取代原来只看名字/税目号的字面召回。
// 幂等可重跑:源内容 sha256 未变则跳过;支持 --limit 分批、--dry-run 试跑、--force 重抽、--only 指定判例。
// 改库前用 VACUUM INTO 备份;抽取在单事务内写入;单条失败不中断全量,末尾报告并可再次重跑。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return (v === undefined || String(v).startsWith('--')) ? true : v;
}
const has = name => process.argv.includes('--' + name);

const DB_PATH = path.resolve(ROOT, String(arg('db', 'hs_copilot.db')));
const LIMIT = Number(arg('limit', 0)) || 0;                       // 0 = 全量
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 2)) || 2);
const FORCE = has('force');
const DRY = has('dry-run');
const NO_BACKUP = has('no-backup');
const ONLY = String(arg('only', '') || '');                       // 逗号分隔 case_id,调试用

// ---------- LLM 通道:读 llm.config.json,依次降级;429/限流等待后重试 ----------
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'llm.config.json'), 'utf8'));
const PROVIDERS = (cfg.providers || []).map(p => ({
  name: p.name, base: String(p.baseUrl || '').replace(/\/$/, ''), key: p.apiKey,
  models: p.models || [], extraBody: p.extraBody || null
}));

function pickText(d) {
  return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
}
async function postChat(provider, model, messages, useJson, timeoutMs) {
  const body = { model, messages, temperature: 0, max_tokens: 800 };
  if (useJson) body.response_format = { type: 'json_object' };
  if (provider.extraBody) Object.assign(body, provider.extraBody);
  const r = await fetch(provider.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    // 通道不支持 json_object 时去掉该参数重试一次
    if (r.status === 400 && useJson && /response_format|json/i.test(t))
      return postChat(provider, model, messages, false, timeoutMs);
    throw new Error(model + ' HTTP ' + r.status + ' ' + t.slice(0, 120));
  }
  const d = await r.json();
  return { text: pickText(d), reportedModel: typeof d.model === 'string' ? d.model : model };
}
function parseJSON(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(t); } catch { /* 继续尝试截取 */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error('输出不是有效 JSON');
}
async function callLLM(messages) {
  let lastErr = null;
  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await postChat(provider, model, messages, true, 60000);
          return { data: parseJSON(res.text), model: res.reportedModel || model, provider: provider.name };
        } catch (e) {
          lastErr = e;
          if (/429|FreeUsageLimit|rate.?limit|Insufficient/i.test(e.message) && attempt < 2) {
            await new Promise(r => setTimeout(r, 12000)); // 免费额度按分钟限流,等 12 秒再试
            continue;
          }
          break; // 非限流错误或已重试过 → 下一个模型
        }
      }
    }
  }
  throw lastErr || new Error('所有模型通道均不可用');
}

// ---------- 抽取 prompt:特征维度对齐 UNDERSTAND_SYSTEM ----------
// 归类范畴枚举:判例与在线商品理解共用同一套,作为“本质相似”的主匹配信号。
const CATEGORY_LIST = ['储能供电','照明灯具','容器包装','交通运输','电子电气','机械设备','医疗检测','食品加工','纺织服装','塑料橡胶制品','金属制品','玻璃陶瓷制品','木纸制品','化学制品','玩具运动','家具家居','其他'];
const CATEGORY_SET = new Set(CATEGORY_LIST);

const EXTRACT_SYSTEM = `你是中国海关 HS 归类专家。给你一条历史归类判例的商品信息,请抽取该商品的客观归类特征,用于后续“按商品本质相似度”检索判例。
只输出 JSON,不要任何解释文字、不要代码块标记:
{
  "category": "从下列归类范畴中选最贴切的一个(只填一个,原样照抄枚举词):${CATEGORY_LIST.join('/')}",
  "sub_category": "若商品明显横跨两个范畴,填次要范畴(同一枚举,原样照抄);否则留空字符串",
  "core_product": "去掉所有修饰词后,这个东西是什么(名词短语)",
  "materials": ["主要制成材料,如 塑料/玻璃/不锈钢/锂离子;没有明确依据就空数组"],
  "function": "功能或工作原理,一句话;没有就空字符串",
  "structure": "影响归类的关键结构特征,一句话;没有就空字符串",
  "usage": "用途或使用场景,一句话;没有就空字符串"
}
要求:category 必须取自枚举原词,拿不准就填“其他”;只依据给定信息抽取,没有依据就留空,禁止编造;不得输出任何 HS 编码结论。`;

function caseInput(row) {
  return [
    '商品中文名:' + (row.product_name_cn || ''),
    row.product_name_en ? '商品英文名:' + row.product_name_en : '',
    row.specification ? '规格:' + row.specification : '',
    row.product_description ? '商品描述:' + row.product_description : '',
    row.classification_decision ? '归类决定:' + row.classification_decision : '',
    row.rule_basis ? '归类依据:' + row.rule_basis : ''
  ].filter(Boolean).join('\n');
}
function normFeature(data) {
  const root = data && typeof data === 'object' ? data : {};
  const str = (v, max) => String(v || '').trim().slice(0, max);
  const list = (v, max, itemMax) => [...new Set((Array.isArray(v) ? v : [])
    .map(x => String(x || '').trim()).filter(Boolean).map(x => x.slice(0, itemMax)).slice(0, max))];
  const cat = v => CATEGORY_SET.has(str(v, 12)) ? str(v, 12) : '';
  return {
    category: cat(root.category) || '其他',
    sub_category: cat(root.sub_category),
    core_product: str(root.core_product, 40),
    materials: list(root.materials, 6, 20),
    function: str(root.function, 100),
    structure: str(root.structure, 100),
    usage: str(root.usage, 100)
  };
}

const FEATURE_DDL = `CREATE TABLE IF NOT EXISTS ruling_case_feature (
  case_id TEXT PRIMARY KEY,
  category TEXT, sub_category TEXT,
  core_product TEXT, materials TEXT, function TEXT, structure TEXT, usage TEXT,
  feature_model TEXT, extracted_at TEXT, feature_sha256 TEXT,
  FOREIGN KEY(case_id) REFERENCES ruling_case(case_id) ON DELETE CASCADE
)`;

function srcSha(row) {
  return crypto.createHash('sha256').update(JSON.stringify([
    row.product_name_cn, row.product_name_en, row.specification,
    row.product_description, row.classification_decision, row.rule_basis
  ])).digest('hex');
}

async function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('数据库不存在:' + DB_PATH); process.exit(1); }
  const db = new DatabaseSync(DB_PATH);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  if (!tables.has('ruling_case')) { console.error('缺少 ruling_case 表,请先导入判例'); process.exit(1); }
  // 特征表是可重抽的派生数据:schema 升级(如新增 category 列)时直接重建,原始判例不受影响
  if (tables.has('ruling_case_feature')) {
    const fcols = db.prepare('PRAGMA table_info(ruling_case_feature)').all().map(c => c.name);
    if (!fcols.includes('category')) { db.exec('DROP TABLE ruling_case_feature'); console.log('特征表 schema 升级,已重建。'); }
  }
  db.exec(FEATURE_DDL);

  const onlyIds = ONLY ? ONLY.split(',').map(s => s.trim()).filter(Boolean) : null;
  let rows = db.prepare(`SELECT case_id,product_name_cn,product_name_en,specification,
    product_description,classification_decision,rule_basis FROM ruling_case ORDER BY case_id`).all();
  if (onlyIds) rows = rows.filter(r => onlyIds.includes(r.case_id));

  const existing = new Map(db.prepare('SELECT case_id,feature_sha256 FROM ruling_case_feature').all()
    .map(r => [r.case_id, r.feature_sha256]));
  let todo = [];
  for (const row of rows) {
    const sha = srcSha(row);
    if (!FORCE && existing.get(row.case_id) === sha) continue; // 幂等:源未变则跳过
    todo.push({ row, sha });
  }
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);

  console.log(`判例 ${rows.length} 条,待抽取 ${todo.length} 条(跳过已存在 ${rows.length - todo.length}),` +
    `dry-run=${DRY} concurrency=${CONCURRENCY}`);
  if (!todo.length) { db.close(); return; }

  if (!DRY && !NO_BACKUP) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = path.join(ROOT, 'tools', 'backup', `hs_copilot-before-features-${stamp}.db`);
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    console.log('已备份:' + path.relative(ROOT, bak));
  }

  const insert = db.prepare(`INSERT INTO ruling_case_feature
    (case_id,category,sub_category,core_product,materials,function,structure,usage,feature_model,extracted_at,feature_sha256)
    VALUES (@case_id,@category,@sub_category,@core_product,@materials,@function,@structure,@usage,@model,@at,@sha)
    ON CONFLICT(case_id) DO UPDATE SET
      category=@category,sub_category=@sub_category,core_product=@core_product,materials=@materials,
      function=@function,structure=@structure,usage=@usage,feature_model=@model,extracted_at=@at,feature_sha256=@sha`);

  const results = { ok: 0, fail: 0, failures: [] };
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const { row, sha } = todo[idx++];
      try {
        const { data, model } = await callLLM([
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: caseInput(row) }
        ]);
        const f = normFeature(data);
        const rec = { case_id: row.case_id, category: f.category, sub_category: f.sub_category,
          core_product: f.core_product, materials: JSON.stringify(f.materials),
          function: f.function, structure: f.structure, usage: f.usage, model,
          at: new Date().toISOString(), sha };
        if (DRY) console.log(`[dry] ${row.case_id} (${model}) ${row.product_name_cn} → ${JSON.stringify(f)}`);
        else insert.run(rec);
        results.ok++;
      } catch (e) {
        results.fail++; results.failures.push({ case_id: row.case_id, name: row.product_name_cn, error: e.message });
        console.error(`[fail] ${row.case_id} ${row.product_name_cn}: ${e.message}`);
      }
      process.stdout.write(`\r进度 ${results.ok + results.fail}/${todo.length}(成功 ${results.ok} 失败 ${results.fail})  `);
      await new Promise(r => setTimeout(r, 300)); // 轻微节流,降低免费通道限流概率
    }
  }

  if (!DRY) db.exec('BEGIN');
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (!DRY) db.exec('COMMIT');
  } catch (e) {
    if (!DRY) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    console.error('\n事务失败已回滚:' + e.message); process.exitCode = 1;
  }
  console.log(`\n完成:成功 ${results.ok},失败 ${results.fail}。`);
  if (results.failures.length) {
    const out = path.join(ROOT, 'tools', 'data', 'feature-extract-failures.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(results.failures, null, 2));
    console.log('失败清单已写入 tools/data/feature-extract-failures.json;直接重跑即可(幂等跳过已成功)。');
    process.exitCode = 1;
  }
  db.close();
}
main().catch(e => { console.error(e); process.exit(1); });
