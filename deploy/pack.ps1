# HS Copilot 本机打包脚本（Windows PowerShell）
# 作用：把项目打成可上传服务器的 tar.gz，自动剔除体积巨大/运行期无关/含密钥的内容。
#
# 用法（在项目里任意位置打开 PowerShell）：
#   .\deploy\pack.ps1                    # 打到 d:\hs-copilot.tar.gz（不含密钥）
#   .\deploy\pack.ps1 -Out D:\pkg\a.tar.gz
#   .\deploy\pack.ps1 -IncludeSecret     # 连 llm.config.json 一起打进去（不推荐，密钥应单独 scp）
#
# 打包后用 scp 上传：
#   scp d:\hs-copilot.tar.gz root@你的公网IP:/root/

[CmdletBinding()]
param(
  # 输出文件路径，默认放在项目同级目录（项目树之外，避免把自己打进自己）
  [string]$Out,
  # 是否把含密钥的 llm.config.json 一并打包（默认否，建议单独上传并 chmod 600）
  [switch]$IncludeSecret
)

$ErrorActionPreference = 'Stop'

# 项目根目录 = 本脚本所在的 deploy 的上一级
$ProjectRoot = Split-Path $PSScriptRoot -Parent
if (-not $Out) {
  $Out = Join-Path (Split-Path $ProjectRoot -Parent) 'hs-copilot.tar.gz'
}

Write-Host "项目根目录 : $ProjectRoot"
Write-Host "输出文件   : $Out"

# 运行期不需要、且体积巨大或含敏感信息的目录/文件，一律排除
$excludes = @(
  '--exclude=./.git',            # 561MB 版本库，服务器不需要
  '--exclude=./.workbuddy',      # 本地记忆目录
  '--exclude=./tools/backup',    # ~130MB 旧数据库快照
  '--exclude=./tools/raw',       # ~67MB 原始 PDF 素材
  '--exclude=./server.log',      # 本地日志
  '--exclude=./deploy/dist',     # 若把产物放这里，别打进去
  '--exclude=__pycache__',
  '--exclude=*.pyc',
  '--exclude=*.db-shm',
  '--exclude=*.db-wal',
  '--exclude=node_modules'
)
if (-not $IncludeSecret) {
  $excludes += '--exclude=./llm.config.json'   # 含 API 密钥，单独上传
  Write-Host "已排除 llm.config.json（含密钥，请单独 scp 上传）"
} else {
  Write-Warning "已把 llm.config.json 打进包里，注意包体含明文密钥，别乱传！"
}

if (Test-Path $Out) { Remove-Item $Out -Force }

# 用 Windows 自带 bsdtar 打包：-C 到项目根，归档 . （条目形如 ./server.js）
& tar -czf $Out -C $ProjectRoot @excludes '.'
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败，退出码 $LASTEXITCODE" }

# 校验产物：大小 + 确认敏感/巨大文件没被误打进去
$sizeMB = [math]::Round((Get-Item $Out).Length / 1MB, 2)
Write-Host ""
Write-Host "打包完成：$Out（$sizeMB MB）"

$list = & tar -tzf $Out
$mustHave = @('./server.js', './index.html', './hs_copilot.db', './deploy/ecosystem.config.cjs')
$mustNot  = @('./.git/', './tools/backup/', './tools/raw/')
if (-not $IncludeSecret) { $mustNot += './llm.config.json' }

$missing = @($mustHave | Where-Object { $list -notcontains $_ })
$leaked  = @()
foreach ($bad in $mustNot) {
  if (@($list | Where-Object { $_ -like "$bad*" }).Count -gt 0) { $leaked += $bad }
}

if ($missing) { Write-Warning "包里缺少关键文件：$($missing -join ', ')" }
if ($leaked)  { Write-Warning "包里混入了应排除的内容：$($leaked -join ', ')" }
if (-not $missing -and -not $leaked) {
  Write-Host "校验通过：关键文件齐全，敏感/巨大内容已排除。" -ForegroundColor Green
}
