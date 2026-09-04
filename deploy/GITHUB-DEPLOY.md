# 从 GitHub 部署到阿里云

仓库：`du24601-png/hs-copilot-web`，部署分支：`main`。以下环境步骤适用于 Ubuntu 24.04；其他系统需调整安装命令。

## 1. 准备服务器

用 SSH 登录服务器。在本机把安装脚本单独上传，然后在服务器执行：

```powershell
scp .\deploy\setup-server.sh root@你的公网IP:/root/
```

```bash
bash /root/setup-server.sh
```

脚本安装 Git、Node.js 24、PM2 和 Nginx，并创建应用与日志目录。
本项目没有 npm 运行依赖，无需在应用目录执行 `npm install`。

## 2. 让服务器读取私有仓库

在服务器生成专用于该仓库的 SSH 密钥：

```bash
ssh-keygen -t ed25519 -C hs-copilot-deploy -f ~/.ssh/hs-copilot-deploy
cat ~/.ssh/hs-copilot-deploy.pub
```

把打印的**公钥**添加到 GitHub 仓库 Settings → Deploy keys；不勾选 Allow write access。
私钥留在服务器。编辑服务器的 `~/.ssh/config`，加入（保留文件已有内容）：

```sshconfig
Host github-hs-copilot
    HostName github.com
    User git
    IdentityFile ~/.ssh/hs-copilot-deploy
    IdentitiesOnly yes
```

首次 SSH 连接时核对 GitHub 的主机密钥指纹。

```bash
chmod 600 ~/.ssh/config ~/.ssh/hs-copilot-deploy
git clone --branch main --single-branch git@github-hs-copilot:du24601-png/hs-copilot-web.git /opt/hs-copilot
cd /opt/hs-copilot
```

`/opt/hs-copilot` 必须为空目录；已有部署时先检查内容，不要直接覆盖。

## 3. 单独配置模型密钥

```bash
cd /opt/hs-copilot
umask 077
cp llm.config.example.json llm.config.json
nano llm.config.json
chmod 600 llm.config.json
```

填写真实 `apiKey`、服务商 `baseUrl` 和可用的 `models`。
也可以从本机使用 SCP 单独传输现有 `llm.config.json`，保留当前的多通道配置。
不要将密钥写入 README、PM2 配置或 GitHub 仓库。项目不会自动读取 `.env`。

## 4. 启动并配置反向代理

```bash
cd /opt/hs-copilot
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup
curl -f http://127.0.0.1:7100/api/health
```

按 `pm2 startup` 输出的命令完成开机自启。
健康检查应包含 `db: true`；`llm: true` 只表示读取到了配置，不证明模型余额或接口可用。

先复制 Nginx 模板，在服务器配置目录中填写你的域名或公网 IP：

```bash
cp deploy/nginx-hs-copilot.conf /etc/nginx/sites-available/hs-copilot
nano /etc/nginx/sites-available/hs-copilot  # 修改 server_name
ln -sfn /etc/nginx/sites-available/hs-copilot /etc/nginx/sites-enabled/hs-copilot
nginx -t && systemctl reload nginx
```

域名修改保留在 `/etc/nginx/` 中，避免后续 `git pull` 因项目配置的本地改动而冲突。
如有现存站点，检查 `server_name` 和默认站点配置是否冲突。
阿里云防火墙/安全组按需开放 80、443，SSH 22 限制管理来源；应用 7100 不对公网开放。
此模板按单层 Nginx 代理配置，覆盖客户端的 `X-Forwarded-For`，保证按实际来源 IP 限流。
若以后增加 CDN 或负载均衡，需重新配置可信代理来源。
域名的 HTTPS 证书与服务器实际访问验证在服务器配置阶段完成。

## 5. 验证

```bash
curl -f http://127.0.0.1:7100/api/health
curl -f http://127.0.0.1:7100/api/hs/9608992000
curl -I http://你的域名或IP/
curl -I http://你的域名或IP/llm.config.json
curl -I http://你的域名或IP/hs_copilot.db
```

首页应返回 200；密钥与数据库路径应返回 403。浏览器还需完成一条真实归类，确认模型通道可用。
公开 AI 接口已有每 IP 每分钟 20 次的进程内限流；这不是总额度限制，多来源请求仍会消耗模型余额。

## 6. 后续更新和回滚

本机提交并推送 GitHub 后，在服务器执行：

```bash
cd /opt/hs-copilot
git status --short
git rev-parse HEAD  # 记下旧提交，供回滚
git pull --ff-only origin main && pm2 restart deploy/ecosystem.config.cjs --update-env
curl -f http://127.0.0.1:7100/api/health
```

仅在工作区无未提交改动时更新；遇到冲突先处理，不使用强制重置。
`llm.config.json` 已忽略，拉取代码不会覆盖它。数据库随代码更新，导入前需另存数据副本。

需要临时回滚时，在工作区干净的前提下执行：

```bash
git switch --detach 上一步记下的旧提交
pm2 restart deploy/ecosystem.config.cjs --update-env
```

恢复更新前执行 `git switch main`，再按上面的更新步骤操作。
