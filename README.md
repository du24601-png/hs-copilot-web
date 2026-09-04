# HS Copilot

中文 HS 商品归类辅助工作台：商品理解、候选检索、属性确认和带依据的结果展示。
后端使用 Node.js 内置 HTTP 与 SQLite 模块，运行时没有第三方 npm 依赖。

## 本地运行

安装 Node.js 24，然后在项目根目录执行：

```bash
cp llm.config.example.json llm.config.json
# 编辑 llm.config.json，填写你自己的 apiKey、baseUrl 和 models
npm start
```

Windows PowerShell 可使用 `Copy-Item llm.config.example.json llm.config.json`。
浏览器访问 `http://127.0.0.1:7100`。未配置模型密钥时仍可查询数据库，但无法完成 AI 归类。
配置中 `providers` 按顺序尝试；示例中的模型名是占位符，须替换为账号可调用的模型 ID。

## 阿里云部署

按 [GitHub 拉取部署说明](deploy/GITHUB-DEPLOY.md) 操作：GitHub 私有仓库 → 阿里云 Ubuntu → PM2 → Nginx。
应用默认只监听 `127.0.0.1:7100`，由 Nginx 对外提供访问。

`hs_copilot.db` 是运行必需的只读税则与知识库，随项目提交；更新数据时仍需保留可回滚版本。
判例层默认关闭，配置见 `ruling.config.json`。历史判例与现行税则数据需要分别判断适用性。

## 检查

```bash
npm test
python -m pip install -r tools/requirements.txt
npm run test:data
```

JavaScript 回归使用模拟模型响应；真实商品评测脚本会调用配置的模型并可能产生费用。
Python 只用于数据导入和相关测试，网站运行不需要 Python。

当前已知问题：包含 `ruling_case_feature` 的数据库重导入判例时，导入程序的完整性保护会阻止提交并回滚，
因此 `test:data` 中该场景有 1 项失败。部署直接使用随仓库提供的数据库，无需重导入；修复前勿将重导入加入发布步骤。

## 提交边界

- 不提交 `llm.config.json`、`.env*`、私钥、运行日志、依赖目录、缓存和部署压缩包。
- 配置示例只保留空密钥和占位符；服务器密钥单独配置。
- 已保存的评测数据和指定实验日志用于追溯，保留在仓库中；本地生成的报告位于已忽略的 `docs/reports/`。
- `.gitignore` 不会移除已被 Git 跟踪的文件，提交前仍需检查暂存清单。
