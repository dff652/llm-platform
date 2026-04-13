#!/bin/bash
# 前端守护脚本：检测前端进程，挂了自动重启
# 用法：nohup ./scripts/watch-frontend.sh > /tmp/watch-frontend.log 2>&1 &

cd "$(dirname "$0")/../frontend" || exit 1

while true; do
    if ! lsof -ti:5175 > /dev/null 2>&1; then
        echo "[$(date)] 前端未运行，启动..."
        setsid nohup npm run dev > /tmp/frontend.log 2>&1 &
        sleep 5
        if lsof -ti:5175 > /dev/null 2>&1; then
            echo "[$(date)] 前端启动成功"
        else
            echo "[$(date)] 前端启动失败，30s 后重试"
            sleep 25
        fi
    fi
    sleep 10
done
