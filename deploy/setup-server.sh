#!/usr/bin/env bash
# HS Copilot 服务器环境一键安装脚本（阿里云 / Ubuntu 24.04 LTS）
# 作用：装 Node 24 + pm2 + nginx，并验证 node:sqlite 可用。不碰防火墙（放到部署清单里手动做，避免 SSH 锁死）。
#
# 用法：以 root 登录服务器后执行（先把本文件上传到 /root/）：
#   bash /root/setup-server.sh
# 特性：幂等，可重复执行。
set -euo pipefail

log() { echo -e "\n\033[1;32m==> $*\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log "1/6 更新系统软件源"
apt-get update -y
apt-get install -y ca-certificates curl git

log "2/6 安装 Node 24（NodeSource 源）"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "Node 版本：$(node -v)"
echo "npm  版本：$(npm -v)"

log "3/6 验证 node:sqlite 可用（本项目核心依赖）"
# 会打印一行 ExperimentalWarning，属正常，退出码为 0 即成功
node -e "require('node:sqlite'); console.log('sqlite OK')" || {
  echo "node:sqlite 不可用：Node 版本过低（需 v22.5+，推荐 v24）" >&2
  exit 1
}

log "4/6 安装 pm2（进程守护，挂了自动重启）"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
echo "pm2 版本：$(pm2 -v)"

log "5/6 安装 nginx（对外门户 + 后续 HTTPS）"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get install -y nginx
fi
systemctl enable nginx >/dev/null 2>&1 || true
nginx -v 2>&1 || true

log "6/6 创建应用日志目录"
mkdir -p /var/log/hs-copilot
mkdir -p /opt/hs-copilot

log "环境就绪。下一步：从 GitHub 克隆到 /opt/hs-copilot，单独配置 llm.config.json，再 pm2 启动（见 deploy/GITHUB-DEPLOY.md）"
