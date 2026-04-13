#!/bin/bash
# tmux 托管前后端服务
# 用法：./scripts/tmux-start.sh
# 查看：tmux attach -t ts
# 切换窗口：Ctrl+B 然后按 0(后端) 或 1(前端)

set -e
cd "$(dirname "$0")/.."

# 如果 session 已存在，先销毁
tmux kill-session -t ts 2>/dev/null || true

# 后端
tmux new-session -d -s ts -n backend -c "$PWD/backend"
tmux send-keys -t ts:backend "python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8100 --workers 1 --no-access-log" Enter

# 前端
tmux new-window -t ts -n frontend -c "$PWD/frontend"
tmux send-keys -t ts:frontend "npm run dev" Enter

echo "✓ tmux session 'ts' 已启动（后端 + 前端）"
echo "  查看日志：tmux attach -t ts"
echo "  切换窗口：Ctrl+B 0(后端) / Ctrl+B 1(前端)"
echo "  停止全部：tmux kill-session -t ts"
