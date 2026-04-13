#!/usr/bin/env bash
#
# TS-Platform 开发环境管理工具
#
# 交互式:  ./scripts/dev.sh
# 命令式:  ./scripts/dev.sh <command>
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)

# ---- 端口 & 路径 ----

PORT_BACKEND=8100
PORT_FRONTEND=5175
PORT_REDIS=6379
PORT_POSTGRES=5432
DEV_COMPOSE="$PROJECT_DIR/docker-compose.dev.yml"
LOG_DIR="$PROJECT_DIR/backend/logs"
LOG_APP="$LOG_DIR/app.log"
LOG_CELERY="$LOG_DIR/celery.log"
LOG_FRONTEND="/tmp/ts-frontend-dev.log"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"

# ---- 颜色 & 样式 ----

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC} $*"; }

# ---- 状态检测 ----

_port_pid() {
    lsof -ti :"$1" 2>/dev/null | head -1
}

_is_running() {
    [ -n "$(_port_pid "$1")" ]
}

_service_status() {
    local name=$1 port=$2
    if _is_running "$port"; then
        local pid
        pid=$(_port_pid "$port")
        echo -e "${GREEN}运行中${NC} (PID $pid, :$port)"
    else
        echo -e "${DIM}未启动${NC}"
    fi
}

_celery_status() {
    local pids
    pids=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null | head -1)
    if [ -n "$pids" ]; then
        local count
        count=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null | wc -l)
        echo -e "${GREEN}运行中${NC} ($count 进程)"
    else
        echo -e "${DIM}未启动${NC}"
    fi
}

is_postgres_up() {
    # lsof 对 Docker 容器进程可能没权限，用 pg_isready 或 ss 检测
    pg_isready -h localhost -p $PORT_POSTGRES -q 2>/dev/null || \
    ss -tlnp 2>/dev/null | grep -q ":${PORT_POSTGRES} " 2>/dev/null
}
is_backend_up()  { _is_running $PORT_BACKEND; }
is_frontend_up() { _is_running $PORT_FRONTEND; }
is_redis_up()    { _is_running $PORT_REDIS; }
is_celery_up()   { pgrep -f "celery -A app.core.celery_app worker" >/dev/null 2>&1; }

_postgres_status() {
    if is_postgres_up; then
        local container
        container=$(docker ps --filter "name=ts-dev-postgres" --format "{{.Status}}" 2>/dev/null || true)
        if [ -n "$container" ]; then
            echo -e "${GREEN}运行中${NC} (容器, :$PORT_POSTGRES)"
        else
            echo -e "${GREEN}运行中${NC} (外部, :$PORT_POSTGRES)"
        fi
    else
        echo -e "${DIM}未启动${NC}"
    fi
}

anything_running() {
    is_backend_up || is_frontend_up || is_celery_up
}

# ---- 交互式菜单 ----

show_banner() {
    echo ""
    echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${BLUE}║     TS-Platform 开发环境管理工具         ║${NC}"
    echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
    echo ""

    echo -e "${BOLD}  当前状态:${NC}"
    echo -e "    PostgreSQL: $(_postgres_status)"
    echo -e "    Redis:      $(_service_status Redis $PORT_REDIS)"
    echo -e "    后端:       $(_service_status Backend $PORT_BACKEND)"
    echo -e "    Celery:     $(_celery_status)"
    echo -e "    前端:       $(_service_status Frontend $PORT_FRONTEND)"
    echo ""
}

show_menu() {
    echo -e "${BOLD}  请选择操作:${NC}"
    echo ""
    echo -e "  ${BOLD}启动${NC}"
    echo -e "    ${CYAN}1)${NC} 一键启动        启动全部服务"
    echo -e "    ${CYAN}2)${NC} 启动后端        Redis + Backend + Celery"
    echo -e "    ${CYAN}3)${NC} 启动前端        Vite dev server"
    echo ""

    if anything_running; then
        echo -e "  ${BOLD}运维${NC}"
        echo -e "    ${CYAN}4)${NC} 重启全部        停止 + 重新启动"
        echo -e "    ${CYAN}5)${NC} 重启后端        仅重启 Backend + Celery"
        echo -e "    ${CYAN}6)${NC} 查看日志        选择日志源查看"
        echo -e "    ${CYAN}7)${NC} 查看状态        详细进程信息"
        echo ""
        echo -e "  ${BOLD}GPU 引擎${NC}"
        echo -e "    ${CYAN}g)${NC} GPU 状态        查看 vLLM 进程 + 引擎配置"
        echo -e "    ${CYAN}G)${NC} 启动 GPU        启动 enabled 的 GPU 引擎"
        echo -e "    ${CYAN}K)${NC} 停止 GPU        停止所有 vLLM 进程"
        echo -e "    ${CYAN}R)${NC} 重启 GPU        重启所有 vLLM 进程"
        echo ""
        echo -e "  ${BOLD}停止${NC}"
        echo -e "    ${CYAN}s)${NC} 停止全部        停止所有服务（不含 GPU）"
        echo -e "    ${CYAN}b)${NC} 仅停后端        停止 Backend + Celery"
        echo -e "    ${CYAN}f)${NC} 仅停前端        停止 Frontend"
        echo ""
    fi

    echo -e "    ${DIM}q) 退出${NC}"
    echo ""
}

interactive_menu() {
    while true; do
        show_banner
        show_menu

        local choice
        read -rp "  请输入选项: " choice
        echo ""

        case "$choice" in
            1) cmd_start_all; echo ""; read -rp "  按回车继续..." _ ;;
            2) cmd_start_backend; echo ""; read -rp "  按回车继续..." _ ;;
            3) cmd_start_frontend; echo ""; read -rp "  按回车继续..." _ ;;
            4) cmd_restart_all; echo ""; read -rp "  按回车继续..." _ ;;
            5) cmd_restart_backend; echo ""; read -rp "  按回车继续..." _ ;;
            6) cmd_logs_menu ;;
            7) cmd_status_detail; echo ""; read -rp "  按回车继续..." _ ;;
            g) cmd_gpu_status; read -rp "  按回车继续..." _ ;;
            G) cmd_start_gpu; echo ""; read -rp "  按回车继续..." _ ;;
            K) cmd_stop_gpu; echo ""; read -rp "  按回车继续..." _ ;;
            R) cmd_restart_gpu; echo ""; read -rp "  按回车继续..." _ ;;
            s|S) cmd_stop_all; echo ""; read -rp "  按回车继续..." _ ;;
            b|B) cmd_stop_backend; echo ""; read -rp "  按回车继续..." _ ;;
            f|F) cmd_stop_frontend; echo ""; read -rp "  按回车继续..." _ ;;
            q|Q|"") echo -e "  ${DIM}再见${NC}"; exit 0 ;;
            *) warn "无效选项: $choice"; sleep 1 ;;
        esac
    done
}

# ---- 启动函数 ----

_ensure_postgres() {
    if is_postgres_up; then
        info "PostgreSQL 已在运行 (:$PORT_POSTGRES)"
        return
    fi

    if ! command -v docker >/dev/null 2>&1; then
        error "需要 Docker 来运行 PostgreSQL 容器，请先安装 Docker"
    fi

    step "启动 PostgreSQL 容器..."
    docker compose -f "$DEV_COMPOSE" up -d 2>/dev/null || \
        docker-compose -f "$DEV_COMPOSE" up -d 2>/dev/null || \
        error "PostgreSQL 容器启动失败，请检查 Docker 权限"

    for _ in $(seq 1 30); do
        if is_postgres_up; then
            info "PostgreSQL 已启动 (:$PORT_POSTGRES)"
            return
        fi
        sleep 1
    done
    error "PostgreSQL 启动超时"
}

_ensure_redis() {
    if is_redis_up; then
        info "Redis 已在运行"
        return
    fi

    local redis_bin
    redis_bin=$(command -v redis-server 2>/dev/null || true)
    if [ -z "$redis_bin" ]; then
        error "redis-server 不在 PATH 中，请先安装 Redis"
    fi

    step "启动 Redis..."
    redis-server --port $PORT_REDIS --daemonize yes --save "" --dbfilename "" >/dev/null 2>&1

    for _ in $(seq 1 20); do
        if is_redis_up; then
            info "Redis 已启动 (:$PORT_REDIS)"
            return
        fi
        sleep 0.25
    done
    error "Redis 启动超时"
}

_start_backend() {
    if is_backend_up; then
        info "后端已在运行 (:$PORT_BACKEND)"
        return
    fi

    step "启动后端..."
    mkdir -p "$LOG_DIR"
    cd "$BACKEND_DIR"
    nohup python3 -m uvicorn app.main:app --host 0.0.0.0 --port $PORT_BACKEND \
        --no-access-log > /dev/null 2>&1 &
    cd "$PROJECT_DIR"

    # 等待就绪（401 也表示服务已启动）
    for i in $(seq 1 30); do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT_BACKEND}/api/v1/auth/me" 2>/dev/null || echo "000")
        if [ "$code" != "000" ]; then
            sleep 0.5
            info "后端已启动 (:$PORT_BACKEND, PID $(_port_pid $PORT_BACKEND))"
            return
        fi
        sleep 1
    done
    warn "后端启动超时，查看日志: $LOG_APP"
}

_start_celery() {
    if is_celery_up; then
        info "Celery 已在运行"
        return
    fi

    # Celery 由后端 lifespan 自动拉起 (subprocess_manager)
    # 如果后端在运行但 Celery 未启动，手动拉起
    if is_backend_up && ! is_celery_up; then
        step "启动 Celery worker..."
        cd "$BACKEND_DIR"
        nohup python3 -m celery -A app.core.celery_app worker \
            --loglevel=info --concurrency=4 \
            > "$LOG_CELERY" 2>&1 &
        cd "$PROJECT_DIR"
        sleep 2
        if is_celery_up; then
            info "Celery 已启动"
        else
            warn "Celery 启动失败，查看日志: $LOG_CELERY"
        fi
    fi
}

_start_frontend() {
    if is_frontend_up; then
        info "前端已在运行 (:$PORT_FRONTEND)"
        return
    fi

    step "启动前端..."
    cd "$FRONTEND_DIR"
    nohup npm run dev > "$LOG_FRONTEND" 2>&1 &
    cd "$PROJECT_DIR"

    for _ in $(seq 1 15); do
        if is_frontend_up; then
            info "前端已启动 (:$PORT_FRONTEND, PID $(_port_pid $PORT_FRONTEND))"
            return
        fi
        sleep 1
    done
    warn "前端启动超时，查看日志: $LOG_FRONTEND"
}

# ---- 停止函数 ----

_kill_port() {
    local port=$1 name=$2
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 1
        # 检查是否还活着，强制 kill
        pids=$(lsof -ti :"$port" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
        info "$name 已停止"
    fi
}

_kill_celery() {
    local pids
    pids=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 2
        # 强制清理残留
        pids=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
        info "Celery 已停止"
    fi
}

# ---- 命令函数 ----

cmd_start_all() {
    step "启动全部服务..."
    _ensure_postgres
    _ensure_redis
    _start_backend
    sleep 2
    _start_celery
    _start_frontend
    echo ""
    info "全部服务已启动"
    echo -e "    后端:   http://localhost:$PORT_BACKEND"
    echo -e "    前端:   http://localhost:$PORT_FRONTEND"
    echo -e "    API 文档: http://localhost:$PORT_BACKEND/docs"
    echo -e "    账号:   admin / admin123"
}

cmd_start_backend() {
    _ensure_postgres
    _ensure_redis
    _start_backend
    sleep 2
    _start_celery
}

cmd_start_frontend() {
    _start_frontend
}

cmd_stop_all() {
    step "停止全部服务..."
    _kill_port $PORT_FRONTEND "前端"
    _kill_celery
    _kill_port $PORT_BACKEND "后端"
    info "全部服务已停止 (Redis 保持运行)"
    # Check for GPU processes
    local gpu_pids
    gpu_pids=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | grep -v "^$" || true)
    if [ -n "$gpu_pids" ]; then
        warn "GPU 进程仍在运行（vLLM 不随平台退出），如需释放显存:"
        echo "  $0 stop-gpu"
    fi
}

cmd_stop_gpu() {
    local target_id="${1:-}"
    if [ -n "$target_id" ]; then
        # 停止指定引擎：通过端口找进程
        local port
        port=$(_gpu_engine_port "$target_id")
        if [ -n "$port" ]; then
            local pids
            pids=$(lsof -ti :"$port" 2>/dev/null || true)
            if [ -n "$pids" ]; then
                echo "$pids" | xargs kill 2>/dev/null || true
                sleep 2
                pids=$(lsof -ti :"$port" 2>/dev/null || true)
                [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
                info "引擎 $target_id (port $port) 已停止"
            else
                info "引擎 $target_id (port $port) 未在运行"
            fi
        else
            warn "找不到引擎 $target_id 的端口"
        fi
    else
        # 停止所有 vLLM
        local pids
        pids=$(pgrep -f "vllm.entrypoints" 2>/dev/null || true)
        if [ -n "$pids" ]; then
            echo "$pids" | xargs kill 2>/dev/null || true
            sleep 3
            pids=$(pgrep -f "vllm.entrypoints" 2>/dev/null || true)
            [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
            info "所有 vLLM 进程已停止"
        else
            info "没有 vLLM 进程在运行"
        fi
    fi
}

# ---- GPU 引擎管理（从数据库读取配置）----

_gpu_api_token() {
    local user="${TS_ADMIN_USER:-admin}"
    local pass="${TS_ADMIN_PASS:-admin123}"
    curl -s "http://localhost:${PORT_BACKEND}/api/v1/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$user\",\"password\":\"$pass\"}" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null
}

_gpu_engines_json() {
    local token="$1"
    curl -s "http://localhost:${PORT_BACKEND}/api/v1/inference/services" \
        -H "Authorization: Bearer $token" 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for svc in data.get('items', []):
    if svc['service_type'] == 'gpu':
        print(json.dumps(svc))
" 2>/dev/null
}

_gpu_engine_port() {
    local eid="$1"
    if ! is_backend_up; then return; fi
    local token
    token=$(_gpu_api_token) || return
    _gpu_engines_json "$token" | python3 -c "
import sys, json
for line in sys.stdin:
    s = json.loads(line)
    if s['id'] == $eid:
        ep = s.get('endpoint','') or ''
        parts = ep.split(':')
        if len(parts) >= 3:
            print(parts[-1].split('/')[0])
        break
" 2>/dev/null
}

cmd_gpu_status() {
    echo ""
    echo -e "${BOLD}  vLLM 进程:${NC}"
    local found=0
    while IFS= read -r pid; do
        [ -z "$pid" ] && continue
        found=1
        local cmdline port model
        cmdline=$(ps -p "$pid" -o args= 2>/dev/null || echo "?")
        port=$(echo "$cmdline" | grep -oP '(?<=--port )\d+' || echo "?")
        model=$(echo "$cmdline" | grep -oP '(?<=--model )\S+' || echo "?")
        echo -e "    ${GREEN}PID $pid${NC}  port=$port  model=$(basename "$model")"
    done < <(pgrep -f "vllm.entrypoints" 2>/dev/null)
    [ "$found" -eq 0 ] && echo -e "    ${DIM}无 vLLM 进程${NC}"

    if is_backend_up; then
        local token
        token=$(_gpu_api_token 2>/dev/null) || { echo ""; return; }
        echo ""
        echo -e "${BOLD}  GPU 引擎配置:${NC}"
        printf "    %-4s %-28s %-8s %-6s %-25s %s\n" "ID" "名称" "状态" "端口" "模型" "GPU"
        printf "    %-4s %-28s %-8s %-6s %-25s %s\n" "---" "----" "----" "----" "----" "---"
        _gpu_engines_json "$token" | while IFS= read -r line; do
            echo "$line" | python3 -c "
import sys, json
s = json.loads(sys.stdin.read())
ep = s.get('endpoint','') or ''
port = ep.split(':')[-1].split('/')[0] if ':' in ep else '-'
model = (s.get('model_path','') or '').split('/')[-1][:25]
gpu = (s.get('extra_env') or {}).get('CUDA_VISIBLE_DEVICES', s.get('gpu_device','?'))
print(f\"    {s['id']:<4} {s['display_name']:<28} {s['status']:<8} {port:<6} {model:<25} GPU {gpu}\")
"
        done
    fi
    echo ""
}

cmd_start_gpu() {
    local target_id="${1:-}"
    if ! is_backend_up; then
        error "后端未启动，请先 $0 start-be"
    fi

    local token
    token=$(_gpu_api_token) || error "登录失败"

    _gpu_engines_json "$token" | while IFS= read -r line; do
        [ -z "$line" ] && continue

        # 用 stdin 传 JSON，避免 shell 注入
        local svc_id svc_name exec_cmd endpoint status cuda_dev
        eval "$(echo "$line" | python3 -c "
import sys, json, shlex
s = json.loads(sys.stdin.read())
def sq(v): return shlex.quote(str(v))
print(f'svc_id={s[\"id\"]}')
print(f'svc_name={sq(s[\"display_name\"])}')
print(f'exec_cmd={sq(s.get(\"exec_command\") or \"\")}')
print(f'endpoint={sq(s.get(\"endpoint\") or \"\")}')
print(f'status={sq(s[\"status\"])}')
env = s.get('extra_env') or {}
print(f'cuda_dev={sq(env.get(\"CUDA_VISIBLE_DEVICES\",\"\"))}')
")"

        if [ -n "$target_id" ] && [ "$svc_id" != "$target_id" ]; then continue; fi
        if [ -z "$target_id" ] && [ "$status" != "enabled" ]; then
            warn "跳过 $svc_name (status=$status)"
            continue
        fi
        if [ -z "$exec_cmd" ]; then
            warn "跳过 $svc_name (无 exec_command)"
            continue
        fi

        local port
        port=$(echo "$endpoint" | grep -oP ':\K\d+(?=/)' || echo "")
        if [ -n "$port" ] && ss -tlnp 2>/dev/null | grep -q ":$port "; then
            info "$svc_name 已在端口 $port 运行，跳过"
            continue
        fi

        info "启动 $svc_name ..."
        local env_prefix=""
        [ -n "$cuda_dev" ] && env_prefix="CUDA_VISIBLE_DEVICES=$cuda_dev"
        eval "$env_prefix nohup $exec_cmd > /tmp/vllm-${svc_id}.log 2>&1 &"
        info "  PID=$!, 日志: /tmp/vllm-${svc_id}.log"

        if [ -n "$port" ]; then
            echo -n "  等待端口 $port"
            for i in $(seq 1 60); do
                if curl -s "http://localhost:$port/v1/models" >/dev/null 2>&1; then
                    echo ""; info "  $svc_name 就绪 (${i}s)"; break
                fi
                echo -n "."; sleep 2
            done
            curl -s "http://localhost:$port/v1/models" >/dev/null 2>&1 || { echo ""; warn "  启动超时，查看 /tmp/vllm-${svc_id}.log"; }
        fi
    done
}

cmd_restart_gpu() {
    local target_id="${1:-}"
    cmd_stop_gpu "$target_id"
    sleep 2
    cmd_start_gpu "$target_id"
}

cmd_stop_backend() {
    _kill_celery
    _kill_port $PORT_BACKEND "后端"
}

cmd_stop_frontend() {
    _kill_port $PORT_FRONTEND "前端"
}

cmd_restart_all() {
    cmd_stop_all
    sleep 1
    cmd_start_all
}

cmd_restart_backend() {
    cmd_stop_backend
    sleep 1
    cmd_start_backend
}

cmd_status_detail() {
    echo ""
    echo -e "${BOLD}  进程详情:${NC}"
    echo ""

    echo -e "  ${CYAN}PostgreSQL${NC}"
    if is_postgres_up; then
        echo -e "    端口: $PORT_POSTGRES"
        echo -e "    容器: $(docker ps --filter 'name=ts-dev-postgres' --format '{{.Status}}' 2>/dev/null || echo '外部实例')"
        echo -e "    数据库: ts_platform"
    else
        echo -e "    ${DIM}未启动${NC}"
    fi
    echo ""

    echo -e "  ${CYAN}Redis${NC}"
    if is_redis_up; then
        echo -e "    PID:  $(_port_pid $PORT_REDIS)"
        echo -e "    端口: $PORT_REDIS"
        echo -e "    内存: $(redis-cli info memory 2>/dev/null | grep used_memory_human | cut -d: -f2 | tr -d '[:space:]' || echo 'N/A')"
    else
        echo -e "    ${DIM}未启动${NC}"
    fi
    echo ""

    echo -e "  ${CYAN}后端 (FastAPI)${NC}"
    if is_backend_up; then
        echo -e "    PID:  $(_port_pid $PORT_BACKEND)"
        echo -e "    端口: $PORT_BACKEND"
        echo -e "    日志: $LOG_APP"
        local size
        size=$(du -h "$LOG_APP" 2>/dev/null | cut -f1 || echo "0")
        echo -e "    日志大小: $size"
    else
        echo -e "    ${DIM}未启动${NC}"
    fi
    echo ""

    echo -e "  ${CYAN}Celery${NC}"
    if is_celery_up; then
        local count
        count=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null | wc -l)
        local main_pid
        main_pid=$(pgrep -f "celery -A app.core.celery_app worker" 2>/dev/null | head -1)
        echo -e "    主 PID: $main_pid"
        echo -e "    进程数: $count"
        echo -e "    日志: $LOG_CELERY"
    else
        echo -e "    ${DIM}未启动${NC}"
    fi
    echo ""

    echo -e "  ${CYAN}前端 (Vite)${NC}"
    if is_frontend_up; then
        echo -e "    PID:  $(_port_pid $PORT_FRONTEND)"
        echo -e "    端口: $PORT_FRONTEND"
        echo -e "    日志: $LOG_FRONTEND"
    else
        echo -e "    ${DIM}未启动${NC}"
    fi
    echo ""
}

cmd_logs_menu() {
    echo -e "${BOLD}  选择日志:${NC}"
    echo -e "    ${CYAN}1)${NC} 后端日志 (app.log)"
    echo -e "    ${CYAN}2)${NC} Celery 日志"
    echo -e "    ${CYAN}3)${NC} 前端日志"
    echo -e "    ${CYAN}4)${NC} 全部混合"
    echo ""

    local choice
    read -rp "  选择: " choice
    echo ""

    case "$choice" in
        1) info "后端日志 (Ctrl+C 退出)"; tail -f "$LOG_APP" 2>/dev/null || warn "日志文件不存在" ;;
        2) info "Celery 日志 (Ctrl+C 退出)"; tail -f "$LOG_CELERY" 2>/dev/null || warn "日志文件不存在" ;;
        3) info "前端日志 (Ctrl+C 退出)"; tail -f "$LOG_FRONTEND" 2>/dev/null || warn "日志文件不存在" ;;
        4) info "全部日志 (Ctrl+C 退出)"; tail -f "$LOG_APP" "$LOG_CELERY" "$LOG_FRONTEND" 2>/dev/null || warn "日志文件不存在" ;;
        *) warn "无效选项" ;;
    esac
}

# ---- Main ----

# 无参数 → 交互式菜单
if [ $# -eq 0 ]; then
    interactive_menu
    exit 0
fi

# 有参数 → 命令式
case "$1" in
    start)        cmd_start_all ;;
    stop)         cmd_stop_all ;;
    restart)      cmd_restart_all ;;
    status)       show_banner ;;
    logs)         cmd_logs_menu ;;
    start-be)     cmd_start_backend ;;
    start-fe)     cmd_start_frontend ;;
    stop-be)      cmd_stop_backend ;;
    stop-fe)      cmd_stop_frontend ;;
    restart-be)   cmd_restart_backend ;;
    gpu-status)   cmd_gpu_status ;;
    start-gpu)    cmd_start_gpu "${2:-}" ;;
    stop-gpu)     cmd_stop_gpu "${2:-}" ;;
    restart-gpu)  cmd_restart_gpu "${2:-}" ;;
    *)
        echo "用法: $0 [command]"
        echo ""
        echo "  不带参数启动交互式菜单"
        echo ""
        echo "  start           启动全部服务"
        echo "  stop            停止全部服务"
        echo "  restart         重启全部服务"
        echo "  status          查看状态"
        echo "  logs            查看日志"
        echo "  start-be        仅启动后端"
        echo "  start-fe        仅启动前端"
        echo "  stop-be         仅停止后端"
        echo "  stop-fe         仅停止前端"
        echo "  restart-be      重启后端"
        echo "  gpu-status      查看 GPU 引擎状态"
        echo "  start-gpu [id]  启动 GPU 引擎"
        echo "  stop-gpu [id]   停止 GPU 引擎"
        echo "  restart-gpu [id] 重启 GPU 引擎"
        exit 1
        ;;
esac
