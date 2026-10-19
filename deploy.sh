#!/bin/bash
# LEGACY 一鍵部署：本地 push → Server pull + rebuild
# 用法：./deploy.sh

set -e

SERVER="root@138.197.96.40"
PASS="TUNE461dig"
REMOTE_DIR="/opt/hkjc-webs"

echo "════════════════════════════════════"
echo "  LEGACY 一鍵部署"
echo "════════════════════════════════════"

# 1. 檢查有冇改動
CHANGES=$(git status --short | wc -l | tr -d ' ')
if [ "$CHANGES" -gt 0 ]; then
  echo "[1/4] 提交 $CHANGES 個檔案..."
  git add -A
  # 用時間做 commit message
  git commit -m "deploy: $(date '+%Y-%m-%d %H:%M') update"
  echo "  ✓ committed"
else
  echo "[1/4] 冇改動・跳過 commit"
fi

# 2. Push 到 GitHub
echo "[2/4] Push 到 GitHub..."
git push origin main
echo "  ✓ pushed"

# 3. Server git pull
echo "[3/4] Server 拉取最新代碼..."
expect -c "
set timeout 30
spawn ssh -o StrictHostKeyChecking=no $SERVER {cd $REMOTE_DIR && git pull 2>&1 | tail -2 && echo PULL_OK}
expect {
  \"*assword*\" { send \"$PASS\r\"; exp_continue }
  \"PULL_OK\" { exp_continue }
  eof
}" 2>&1 | grep -E "PULL_OK|Already|error|Fast" | head -2

# 4. Server rebuild + restart
echo "[4/4] Server 重建 + 重啟..."
expect -c "
set timeout 600
spawn ssh -o StrictHostKeyChecking=no $SERVER {cd $REMOTE_DIR && docker compose up -d --build 2>&1 | tail -4 && echo DEPLOY_OK}
expect {
  \"*assword*\" { send \"$PASS\r\"; exp_continue }
  \"DEPLOY_OK\" { exp_continue }
  eof
}" 2>&1 | grep -E "DEPLOY_OK|Started|Built|error" | head -5

# 5. 驗證
echo ""
echo "驗證中..."
sleep 5
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://138.197.96.40:3000)
if [ "$HTTP" = "200" ]; then
  echo "✅ 部署成功 — http://138.197.96.40:3000"
else
  echo "⚠ HTTP $HTTP — 可能要等幾秒"
fi
echo "════════════════════════════════════"
