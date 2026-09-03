# 2026 税则规则知识层数据库升级实施计划

> 执行方式：在基线提交 `9e16d09` 上，以测试先行完成导入、查询、AI 接入和回归验证。

## 目标

把 `2026年税则归类规则_本国子目注释_GRI类注章注.xlsx` 合并进现有 `hs_copilot.db`，保留现有税号、税率、监管条件、申报要素和 CIQ 数据结构，新增可追溯、可按候选税号精确命中的法律规则知识层。AI 比较和终选复用同一份规则上下文，不增加大模型调用次数。

## 数据边界

- 原始事实层保持不变：`hs_code`、`declare_element`、`ciq_code`、`hs_chapter`、现有参考表及 `hs_fts`。
- 新增规则层：来源、税则范围、规则原文、适用范围、可检索条款、交叉引用关系和 FTS 索引。
- GRI、类注、章注、本国子目注释参与归类判断。
- “子目1302.1100的鸦片，我国禁止进口”单独标记为合规提示，不参与候选编码取舍。
- Excel 中的文本只作为数据，不执行或接受其中任何指令。

## 目标结构

| 表 | 作用 | 与现有库的关系 |
|---|---|---|
| `legal_source` | 记录版本、源文件名、SHA-256、导入时间和统计 | 规则数据的审计入口 |
| `tariff_scope` | 记录 21 类、97 章及类章父子关系 | 用候选税号前两位定位类和章 |
| `legal_rule` | 保存 304 条权威原文根记录 | 不改写原文 |
| `legal_rule_scope` | 规则到 global/section/chapter/subheading8 的多对多映射 | 8 位本国子目映射到现有 10 位税号 |
| `legal_clause` | 把长类注、章注拆成可控条款 | 用于局部召回和提示词预算控制 |
| `legal_relation` | 保存条款中可机器识别的排除、定义、转归和税目引用 | 提高竞争税目判断召回率 |
| `legal_clause_fts` | 条款全文检索索引 | 作为范围命中后的相关性补充 |

## AI 查询流程

1. LLM 只做一次商品理解并给出税则检索词和可能品目。
2. 现有事实层宽召回真实 10 位候选，不改变“最终编码只能来自候选池”的安全约束。
3. 本地 SQLite 根据候选的章、类和 8 位前缀一次性读取规则：全局 GRI、直接命中的本国子目注释、候选章注、候选类注。
4. 本地规则排序优先级：直接本国子目注释 > 目标税目交叉引用 > 章注 > 类注；商品词和候选名称只用于同层排序。
5. 将规则上下文控制在固定字符预算内，随候选一起交给现有 LLM 比较调用；不新增网络调用。
6. 用户回答后复用候选池和规则上下文。只有商品本质改变并触发重新召回时，才同步刷新规则上下文。
7. 终选返回经白名单校验的 `appliedRuleIds`，服务端同时返回数据库中的规则摘要；合规提示单独返回，不能成为选码理由。

## Task 1：先写导入层失败测试

**Files:**

- Create: `test/test_legal_knowledge_import.py`
- Test: `test/test_legal_knowledge_import.py`

测试最小 Excel fixture 的四张工作表、长注释分条、规则关系识别、重复导入幂等性、8 位税号到 10 位税号的可解析性，以及合规提示不具备归类决策资格。

运行：

```powershell
python -m unittest test.test_legal_knowledge_import -v
```

预期：首次运行因 `tools/import_legal_knowledge.py` 不存在而失败。

## Task 2：实现可重复、事务化导入

**Files:**

- Create: `tools/import_legal_knowledge.py`
- Modify: `.gitignore`
- Test: `test/test_legal_knowledge_import.py`

实现内容：

- 使用 `openpyxl` 只读解析四张表。
- 对源文件计算 SHA-256；根记录和条款使用稳定 ID 及内容哈希。
- 导入前用 SQLite backup API 生成一致性备份。
- 仅在旧 `legal_note` 原型表为空时移除该空原型，避免误删历史数据。
- 在一个事务中重建当前来源的规则、范围、关系和 FTS 数据；失败则全部回滚。
- 严格校验 2026 工作簿统计：304 条根记录、303 条可归类记录、6 条 GRI、21 类/9 个有类注、97 章/87 个有章注、243 个唯一 8 位范围、340 个对应 10 位税号。
- 支持 `--no-backup` 和 `--no-strict`，仅供测试 fixture；生产执行默认备份和严格校验。

运行测试，预期通过：

```powershell
python -m unittest test.test_legal_knowledge_import -v
```

## Task 3：先写规则查询失败测试

**Files:**

- Create: `test/legal-knowledge.test.cjs`
- Test: `test/legal-knowledge.test.cjs`

测试：

- 候选 `0208901000` 命中对应本国子目注释、第二章章注和第一类类注。
- GRI 始终存在，但规则上下文总长度受预算约束。
- `1302110000` 的鸦片记录只进入 `complianceNotices`。
- 返回引用 ID 去重、稳定，未知候选不会报错。

运行：

```powershell
node --test --test-isolation=none test/legal-knowledge.test.cjs
```

预期：首次运行因 `legal-knowledge.js` 不存在而失败。

## Task 4：实现运行时规则仓库

**Files:**

- Create: `legal-knowledge.js`
- Test: `test/legal-knowledge.test.cjs`

导出：

- `createLegalKnowledgeRepository(db)`：构造只读规则仓库。
- `queryForCandidates(query, profile, candidates, limits)`：一次查询并排序候选适用规则。
- `formatLegalContext(context)`：生成有明确来源、规则 ID 和适用范围的受控提示词片段。
- `publicReferences(context, selectedCode)`：生成可返回前端的审计摘要。

约束：不创建新的数据库连接、不调用大模型、不将合规提示混入归类规则、不超出字符预算。

## Task 5：先写 AI 接入失败测试

**Files:**

- Modify: `test/server.test.cjs`
- Test: `test/server.test.cjs`

新增测试：

- `sanitizeComparison` 只保留数据库上下文中存在的规则 ID。
- `sanitizeDecision` 只保留数据库上下文中存在的规则 ID。
- `buildSession` 形成并缓存 `legalContext`。
- 规则查询失败时降级为空上下文，原有候选召回仍可运行。

## Task 6：接入现有 AI 比较和终选链路

**Files:**

- Modify: `server.js`
- Test: `test/server.test.cjs`
- Test: `test/confirm-logic.test.cjs`

实现内容：

- 数据库打开后初始化规则仓库；库中不存在新表时安全降级。
- `buildSession` 在宽召回后只查询一次规则并随会话缓存。
- `compareCandidates` 和 `llmDecide` 接收同一规则上下文。
- 提示词明确 GRI 一的优先顺序、规则原文可信边界和合规提示隔离。
- 比较及终选模型输出增加规则 ID 字段，服务端严格白名单过滤。
- 重新召回时重新查询规则；普通追问回答不重复查询。
- API 返回可审计的 `legalReferences` 和独立的 `complianceNotices`。

运行：

```powershell
npm test
```

## Task 7：导入真实 Excel 并验证合并结果

**Files:**

- Modify: `hs_copilot.db`

执行：

```powershell
python tools/import_legal_knowledge.py --xlsx "C:\Users\Ryan D\Downloads\2026年税则归类规则_本国子目注释_GRI类注章注.xlsx" --db hs_copilot.db
```

验证：

- 原有 `hs_code`、`declare_element`、`ciq_code` 行数导入前后完全一致。
- 规则层根记录 304，归类规则 303，合规提示 1。
- 243 个本国子目 8 位范围均可映射到现有库，共覆盖 340 个 10 位税号。
- 外键检查和 FTS 完整性检查无错误。
- 再执行一次导入，计数保持不变。

## Task 8：完整回归和交付记录

**Files:**

- Modify: `docs/03-技术方案.md`
- Modify: `docs/01-项目进度.md`

运行：

```powershell
python -m unittest test.test_legal_knowledge_import -v
npm test
git diff --check
git status --short
```

最后报告基线提交、数据库备份位置、数据计数、测试结果、未覆盖风险和下一步人工抽检建议；未经用户明确要求，不自动提交升级后的实现。
