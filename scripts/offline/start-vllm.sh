#!/usr/bin/env bash
#
# vLLM GPU 推理服务 — 解压环境 + 启动服务
#
# 用法:
#   sudo bash scripts/start-vllm.sh              # 交互式
#   sudo bash scripts/start-vllm.sh --install    # 只解压环境，不启动
#   sudo bash scripts/start-vllm.sh --start      # 只启动（环境已安装）
#   sudo bash scripts/start-vllm.sh --stop       # 停止 vLLM
#   sudo bash scripts/start-vllm.sh --status     # 查看状态
#
set -euo pipefail

cd "$(dirname "$0")/.."
DEPLOY_DIR=$(pwd)

VLLM_ENV_DIR="${VLLM_ENV_DIR:-/opt/vllm-env}"
VLLM_PKG="$DEPLOY_DIR/vllm-env.tar.gz"
DEFAULT_PORT=8002

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
fail()  { echo -e "  ${RED}[FAIL]${NC} $*"; }
step()  { echo -e "\n${CYAN}[STEP]${NC} ${BOLD}$*${NC}"; }

# ─── 子命令 ───

do_status() {
    echo ""
    echo "vLLM 状态:"

    # 环境
    if [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
        ver=$("$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
        info "环境: $VLLM_ENV_DIR (vLLM $ver)"
    else
        warn "环境未安装"
    fi

    # GPU
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
        gpu_info=$(nvidia-smi --query-gpu=name,memory.free --format=csv,noheader 2>/dev/null || echo "unknown")
        info "GPU: $gpu_info"
    else
        warn "GPU 不可用"
    fi

    # vLLM 进程
    VLLM_PID=$(pgrep -f "vllm.entrypoints" 2>/dev/null | head -1 || echo "")
    if [ -n "$VLLM_PID" ]; then
        port=$(ss -tlnp 2>/dev/null | grep "pid=$VLLM_PID" | grep -oE ':[0-9]+' | head -1 | tr -d ':' | head -1 || echo "?")
        info "vLLM 进程运行中: PID=$VLLM_PID, 端口=$port"
    else
        warn "vLLM 进程未运行"
    fi
    echo ""
}

do_stop() {
    # 杀掉所有 vLLM 相关进程（主进程 + EngineCore 子进程）
    VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
    if [ -n "$VLLM_PIDS" ]; then
        info "停止 vLLM 进程..."
        echo "$VLLM_PIDS" | xargs kill 2>/dev/null || true
        sleep 3
        # 强制杀残留
        VLLM_PIDS=$(pgrep -f "vllm.entrypoints" 2>/dev/null || echo "")
        if [ -n "$VLLM_PIDS" ]; then
            warn "SIGTERM 未生效，发送 SIGKILL..."
            echo "$VLLM_PIDS" | xargs kill -9 2>/dev/null || true
            sleep 2
        fi
        info "vLLM 已停止"
    else
        info "vLLM 未在运行"
    fi

    # 确保 GPU 显存释放
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
        GPU_PIDS=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | sort -u || echo "")
        if [ -n "$GPU_PIDS" ]; then
            warn "GPU 上仍有残留进程，强制释放显存..."
            echo "$GPU_PIDS" | xargs kill -9 2>/dev/null || true
            sleep 2
        fi
        GPU_MEM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null | head -1 || echo "?")
        info "GPU 显存: ${GPU_MEM}"
    fi
}

do_install() {
    step "安装 vLLM 环境"

    if [ -f "$VLLM_ENV_DIR/bin/python3" ]; then
        ver=$("$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "unknown")
        info "vLLM 环境已存在: $VLLM_ENV_DIR (v$ver)"
        return 0
    fi

    if [ ! -f "$VLLM_PKG" ]; then
        # fallback: 上级目录（兼容旧的传输方式）
        VLLM_PKG="$DEPLOY_DIR/../vllm-env.tar.gz"
    fi

    if [ ! -f "$VLLM_PKG" ]; then
        error "vLLM 环境包不存在: 找不到 vllm-env.tar.gz"
    fi

    info "解压 vLLM 环境 ($(du -h "$VLLM_PKG" | cut -f1))..."
    mkdir -p "$VLLM_ENV_DIR"
    tar xzf "$VLLM_PKG" -C "$VLLM_ENV_DIR"

    info "修复路径引用 (conda-unpack)..."
    bash -c "source $VLLM_ENV_DIR/bin/activate && conda-unpack && deactivate" 2>/dev/null || true

    # 修复 conda-pack 可能遗漏的依赖
    info "检查并修复依赖..."
    MISSING_DEPS=""
    for dep in click jinja2 uvloop httptools; do
        if ! "$VLLM_ENV_DIR/bin/python3" -c "import $dep" 2>/dev/null; then
            MISSING_DEPS="$MISSING_DEPS $dep"
        fi
    done
    if [ -n "$MISSING_DEPS" ]; then
        info "安装缺失依赖:$MISSING_DEPS"
        "$VLLM_ENV_DIR/bin/python3" -m pip install $MISSING_DEPS -q 2>/dev/null || warn "部分依赖安装失败，可能需要手动安装"
    fi

    # 验证
    ver=$("$VLLM_ENV_DIR/bin/python3" -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "")
    if [ -n "$ver" ]; then
        info "vLLM $ver 安装成功"
    else
        error "vLLM 安装验证失败，尝试手动修复: $VLLM_ENV_DIR/bin/python3 -m pip install vllm"
    fi

    py_ver=$("$VLLM_ENV_DIR/bin/python3" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' || echo "?")
    info "Python $py_ver"
}

do_start() {
    step "启动 vLLM 服务"

    # 检查环境
    if [ ! -f "$VLLM_ENV_DIR/bin/python3" ]; then
        error "vLLM 环境未安装，先运行: $0 --install"
    fi

    # 检查 GPU
    if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
        error "GPU 不可用（nvidia-smi 失败）"
    fi

    # 检查是否已在运行
    VLLM_PID=$(pgrep -f "vllm.entrypoints" 2>/dev/null | head -1 || echo "")
    if [ -n "$VLLM_PID" ]; then
        warn "vLLM 已在运行 (PID=$VLLM_PID)"
        read -rp "  停止并重启? [y/N]: " restart
        if [[ "$restart" =~ ^[Yy]$ ]]; then
            do_stop
        else
            return 0
        fi
    fi

    # 交互配置
    echo ""
    echo -e "${BOLD}vLLM 启动配置（回车使用 [默认值]）:${NC}"
    echo ""

    # 查找模型目录
    DEFAULT_MODEL=""
    if [ -d "$DEPLOY_DIR/../models" ]; then
        DEFAULT_MODEL=$(find "$DEPLOY_DIR/../models" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1 || echo "")
    fi

    read -rp "  模型路径 [${DEFAULT_MODEL:-无默认}]: " MODEL_PATH
    MODEL_PATH=${MODEL_PATH:-$DEFAULT_MODEL}
    [ -z "$MODEL_PATH" ] && error "必须指定模型路径"
    [ ! -d "$MODEL_PATH" ] && error "模型目录不存在: $MODEL_PATH"

    read -rp "  端口 [$DEFAULT_PORT]: " PORT
    PORT=${PORT:-$DEFAULT_PORT}

    # GPU 数量
    GPU_COUNT=$(nvidia-smi -L 2>/dev/null | wc -l || echo 1)
    if [ "$GPU_COUNT" -gt 1 ]; then
        read -rp "  GPU 数量 (1 或 $GPU_COUNT) [1]: " TP_SIZE
        TP_SIZE=${TP_SIZE:-1}
    else
        TP_SIZE=1
    fi

    read -rp "  CUDA 设备 (例: 0 或 0,1) [0]: " CUDA_DEVICES
    CUDA_DEVICES=${CUDA_DEVICES:-0}

    # 读取模型原始上下文长度
    MODEL_NATIVE_LEN=""
    if [ -f "$MODEL_PATH/config.json" ]; then
        MODEL_NATIVE_LEN=$(python3 -c "
import json, sys
with open('$MODEL_PATH/config.json') as f:
    cfg = json.load(f)
# 按优先级查找: 顶层 > text_config > 其他嵌套
for obj in [cfg, cfg.get('text_config', {}), cfg.get('llm_config', {})]:
    v = obj.get('max_position_embeddings') or obj.get('max_sequence_length')
    if v:
        print(v)
        sys.exit(0)
" 2>/dev/null || echo "")
    fi

    # 根据 GPU 显存自动计算 max_model_len
    GPU_MEM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i "${CUDA_DEVICES%%,*}" 2>/dev/null | head -1 || echo 0)
    if [ "$GPU_MEM_MB" -le 16000 ]; then
        DEFAULT_MAX_LEN=2048
    elif [ "$GPU_MEM_MB" -le 26000 ]; then
        DEFAULT_MAX_LEN=8192
    elif [ "$GPU_MEM_MB" -le 50000 ]; then
        DEFAULT_MAX_LEN=16384
    else
        DEFAULT_MAX_LEN=32768
    fi

    if [ -n "$MODEL_NATIVE_LEN" ]; then
        info "模型原始上下文长度: ${MODEL_NATIVE_LEN} (显存建议: ${DEFAULT_MAX_LEN})"
        if [ "$DEFAULT_MAX_LEN" -gt "$MODEL_NATIVE_LEN" ] 2>/dev/null; then
            DEFAULT_MAX_LEN=$MODEL_NATIVE_LEN
        fi
    fi
    read -rp "  最大序列长度 [$DEFAULT_MAX_LEN]: " MAX_MODEL_LEN
    MAX_MODEL_LEN=${MAX_MODEL_LEN:-$DEFAULT_MAX_LEN}
    if [ -n "$MODEL_NATIVE_LEN" ] && [ "$MAX_MODEL_LEN" -gt "$MODEL_NATIVE_LEN" ] 2>/dev/null; then
        warn "设置值 ($MAX_MODEL_LEN) 超过模型原始上下文长度 ($MODEL_NATIVE_LEN)，vLLM 将拒绝启动"
    fi

    # 构建启动命令
    CMD="$VLLM_ENV_DIR/bin/python3 -m vllm.entrypoints.openai.api_server"
    CMD="$CMD --model $MODEL_PATH"
    CMD="$CMD --port $PORT"
    CMD="$CMD --dtype auto"
    CMD="$CMD --max-model-len $MAX_MODEL_LEN"
    CMD="$CMD --gpu-memory-utilization 0.9"

    ENV_VARS="CUDA_VISIBLE_DEVICES=$CUDA_DEVICES"

    if [ "$TP_SIZE" -gt 1 ]; then
        CMD="$CMD --tensor-parallel-size $TP_SIZE"
        CMD="$CMD --disable-custom-all-reduce --enforce-eager"
        ENV_VARS="$ENV_VARS PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False"
    fi

    echo ""
    info "启动命令:"
    echo "  $ENV_VARS $CMD"
    echo ""
    read -rp "确认启动? [Y/n]: " confirm
    confirm=${confirm:-Y}
    [[ ! "$confirm" =~ ^[Yy]$ ]] && { info "已取消"; return 0; }

    # 日志目录
    LOG_DIR="$DEPLOY_DIR/logs"
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/vllm_$(date +%Y%m%d_%H%M%S).log"

    # 后台启动
    info "启动 vLLM (日志: $LOG_FILE)..."
    env $ENV_VARS nohup $CMD > "$LOG_FILE" 2>&1 &
    VLLM_PID=$!
    info "PID: $VLLM_PID"

    # 等待端口就绪
    info "等待端口 $PORT 就绪..."
    for i in $(seq 1 60); do
        if curl -s "http://localhost:$PORT/v1/models" >/dev/null 2>&1; then
            PY3="${VLLM_ENV_DIR}/bin/python3"
            MODEL_NAME=$(curl -s "http://localhost:$PORT/v1/models" 2>/dev/null | "$PY3" -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'] if d.get('data') else '?')" 2>/dev/null || echo "?")
            echo ""
            echo "============================================================"
            info "vLLM 启动成功!"
            echo "============================================================"
            echo ""
            echo "  端口: $PORT"
            echo "  模型: $MODEL_NAME"
            echo "  PID:  $VLLM_PID"
            echo "  日志: $LOG_FILE"
            echo ""
            # 自动更新平台引擎配置
            BE_PORT=$(grep API_PORT "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8100")
            ADMIN_PASS=$(grep SEED_ADMIN_PASSWORD "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "admin123")
            VLLM_EP="http://host.docker.internal:$PORT/v1"

            TOKEN=$(curl -s "http://localhost:$BE_PORT/api/v1/auth/login" \
                -H "Content-Type: application/json" \
                -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null \
                | "$PY3" -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

            if [ -n "$TOKEN" ]; then
                # 按端口查找引擎：一个端口 = 一个引擎记录
                SERVICES=$(curl -s "http://localhost:$BE_PORT/api/v1/inference/services" \
                    -H "Authorization: Bearer $TOKEN" 2>/dev/null)

                # 查找匹配当前端口的引擎（优先），或同算法的任意引擎
                SVC_ID=$(echo "$SERVICES" | "$PY3" -c "
import sys, json
d = json.loads(sys.stdin.read() or '{}')
port_match = algo_match = None
for s in d.get('items',[]):
    ep = s.get('endpoint') or ''
    if ':$PORT/' in ep:
        port_match = s['id']; break
    if not algo_match and 'qwen' in (s.get('algorithms') or []):
        algo_match = s['id']
print(port_match or algo_match or '')
" 2>/dev/null || echo "")

                MODEL_BASENAME=$(basename "$MODEL_PATH")
                if [ -n "$SVC_ID" ]; then
                    # 更新引擎：endpoint + model_path + status=enabled
                    curl -s -X PUT "http://localhost:$BE_PORT/api/v1/inference/services/$SVC_ID" \
                        -H "Authorization: Bearer $TOKEN" \
                        -H "Content-Type: application/json" \
                        -d "{\"endpoint\":\"$VLLM_EP\",\"model_path\":\"$MODEL_PATH\",\"status\":\"enabled\",\"display_name\":\"$MODEL_BASENAME\"}" >/dev/null 2>&1
                    info "已更新引擎 (id=$SVC_ID):"
                    info "  endpoint: $VLLM_EP"
                    info "  model_path: $MODEL_PATH"
                    info "  status: enabled"
                else
                    # 没有匹配的引擎 → 创建新的
                    SVC_ID=$(curl -s -X POST "http://localhost:$BE_PORT/api/v1/inference/services" \
                        -H "Authorization: Bearer $TOKEN" \
                        -H "Content-Type: application/json" \
                        -d "{\"name\":\"vllm-port-$PORT\",\"display_name\":\"$MODEL_BASENAME\",\"service_type\":\"gpu\",\"endpoint\":\"$VLLM_EP\",\"model_path\":\"$MODEL_PATH\",\"gpu_device\":\"$CUDA_DEVICES\",\"algorithms\":[\"qwen\"],\"status\":\"enabled\"}" 2>/dev/null \
                        | "$PY3" -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
                    if [ -n "$SVC_ID" ]; then
                        info "已创建引擎 (id=$SVC_ID):"
                        info "  endpoint: $VLLM_EP"
                        info "  model_path: $MODEL_PATH"
                    else
                        warn "创建引擎失败，请手动在引擎管理页注册"
                    fi
                fi

                # 禁用其他 GPU 引擎（同算法且不是当前引擎）
                if [ -n "$SVC_ID" ]; then
                    OTHER_IDS=$(echo "$SERVICES" | "$PY3" -c "
import sys, json
d = json.loads(sys.stdin.read() or '{}')
for s in d.get('items',[]):
    if s['service_type'] == 'gpu' and str(s['id']) != '$SVC_ID' and s.get('status') == 'enabled':
        print(s['id'])
" 2>/dev/null)
                    for oid in $OTHER_IDS; do
                        curl -s -X PUT "http://localhost:$BE_PORT/api/v1/inference/services/$oid" \
                            -H "Authorization: Bearer $TOKEN" \
                            -H "Content-Type: application/json" \
                            -d '{"status":"disabled"}' >/dev/null 2>&1
                        info "已禁用多余引擎 (id=$oid)"
                    done
                fi

                # 同步模型注册表 artifact_uri（让 model_name 匹配能找到正确引擎）
                MODEL_BASENAME=$(basename "$MODEL_PATH")
                MODEL_ID=$("$PY3" -c "
import json,sys
r=json.loads(sys.stdin.read())
for m in r.get('items',[]):
    if m.get('family')=='qwen':
        print(m['id']); break
" 2>/dev/null <<< "$(curl -s "http://localhost:$BE_PORT/api/v1/models" -H "Authorization: Bearer $TOKEN" 2>/dev/null)" || echo "")

                if [ -n "$MODEL_ID" ]; then
                    UPDATE_RESULT=$(curl -s -X PUT "http://localhost:$BE_PORT/api/v1/models/$MODEL_ID" \
                        -H "Authorization: Bearer $TOKEN" \
                        -H "Content-Type: application/json" \
                        -d "{\"name\":\"$MODEL_BASENAME\",\"artifact_uri\":\"$MODEL_PATH\"}" 2>/dev/null)
                    UPDATED_NAME=$("$PY3" -c "import json,sys;print(json.loads(sys.stdin.read()).get('name','?'))" 2>/dev/null <<< "$UPDATE_RESULT" || echo "?")
                    info "已同步模型注册表 (id=$MODEL_ID):"
                    info "  name: $UPDATED_NAME"
                    info "  artifact_uri: $MODEL_PATH"
                else
                    warn "未找到 qwen 模型注册记录，model_name 匹配可能失败"
                fi
            else
                warn "平台未运行或登录失败，请手动更新引擎配置"
                echo "  端口: $PORT"
                echo "  模型路径: $MODEL_PATH"
            fi

            echo ""
            info "GPU 验收测试:"
            BE_PORT_HINT=${BE_PORT:-8100}
            echo "  /opt/vllm-env/bin/python3 tests/run_acceptance.py --csv tests/tep_data_1year.csv --method qwen --url http://localhost:$BE_PORT_HINT"
            echo ""
            return 0
        fi

        if ! kill -0 "$VLLM_PID" 2>/dev/null; then
            echo ""
            fail "vLLM 进程已退出，查看日志:"
            echo "  tail -50 $LOG_FILE"
            return 1
        fi

        printf "."
        sleep 5
    done

    echo ""
    warn "等待超时 (300s)，vLLM 可能还在加载模型"
    info "查看日志: tail -f $LOG_FILE"
}

do_start_multi() {
    step "启动多实例 vLLM (Multi-Engine Round-Robin)"

    if [ ! -f "$VLLM_ENV_DIR/bin/python3" ]; then
        error "vLLM 环境未安装，先运行: $0 --install"
    fi
    if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
        error "GPU 不可用"
    fi

    GPU_COUNT=$(nvidia-smi -L 2>/dev/null | wc -l || echo 0)
    if [ "$GPU_COUNT" -lt 2 ]; then
        error "多实例模式需要 ≥2 张 GPU，当前只有 $GPU_COUNT 张"
    fi

    echo ""
    echo -e "${BOLD}多实例配置（回车使用 [默认值]）:${NC}"
    echo ""

    # 模型路径
    DEFAULT_MODEL=""
    if [ -d "$DEPLOY_DIR/../models" ]; then
        DEFAULT_MODEL=$(find "$DEPLOY_DIR/../models" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -1 || echo "")
    fi
    read -rp "  模型路径 [${DEFAULT_MODEL:-无默认}]: " MODEL_PATH
    MODEL_PATH=${MODEL_PATH:-$DEFAULT_MODEL}
    [ -z "$MODEL_PATH" ] && error "必须指定模型路径"
    [ ! -d "$MODEL_PATH" ] && error "模型目录不存在: $MODEL_PATH"

    read -rp "  实例数量 (1-$GPU_COUNT) [$GPU_COUNT]: " INSTANCE_COUNT
    INSTANCE_COUNT=${INSTANCE_COUNT:-$GPU_COUNT}
    if [ "$INSTANCE_COUNT" -gt "$GPU_COUNT" ]; then
        error "实例数量 ($INSTANCE_COUNT) 不能超过 GPU 数量 ($GPU_COUNT)"
    fi

    read -rp "  起始端口 [$DEFAULT_PORT]: " BASE_PORT
    BASE_PORT=${BASE_PORT:-$DEFAULT_PORT}

    # 读取模型原始上下文长度
    MODEL_NATIVE_LEN=""
    if [ -f "$MODEL_PATH/config.json" ]; then
        MODEL_NATIVE_LEN=$(python3 -c "
import json, sys
with open('$MODEL_PATH/config.json') as f:
    cfg = json.load(f)
for obj in [cfg, cfg.get('text_config', {}), cfg.get('llm_config', {})]:
    v = obj.get('max_position_embeddings') or obj.get('max_sequence_length')
    if v:
        print(v)
        sys.exit(0)
" 2>/dev/null || echo "")
    fi

    # 显存自动计算 max_model_len
    GPU_MEM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits -i 0 2>/dev/null | head -1 || echo 0)
    if [ "$GPU_MEM_MB" -le 16000 ]; then
        DEFAULT_MAX_LEN=2048
    elif [ "$GPU_MEM_MB" -le 26000 ]; then
        DEFAULT_MAX_LEN=8192
    elif [ "$GPU_MEM_MB" -le 50000 ]; then
        DEFAULT_MAX_LEN=16384
    else
        DEFAULT_MAX_LEN=32768
    fi

    if [ -n "$MODEL_NATIVE_LEN" ]; then
        info "模型原始上下文长度: ${MODEL_NATIVE_LEN} (显存建议: ${DEFAULT_MAX_LEN})"
        if [ "$DEFAULT_MAX_LEN" -gt "$MODEL_NATIVE_LEN" ] 2>/dev/null; then
            DEFAULT_MAX_LEN=$MODEL_NATIVE_LEN
        fi
    fi
    read -rp "  最大序列长度 [$DEFAULT_MAX_LEN]: " MAX_MODEL_LEN
    MAX_MODEL_LEN=${MAX_MODEL_LEN:-$DEFAULT_MAX_LEN}
    if [ -n "$MODEL_NATIVE_LEN" ] && [ "$MAX_MODEL_LEN" -gt "$MODEL_NATIVE_LEN" ] 2>/dev/null; then
        warn "设置值 ($MAX_MODEL_LEN) 超过模型原始上下文长度 ($MODEL_NATIVE_LEN)，vLLM 将拒绝启动"
    fi

    echo ""
    info "将启动 $INSTANCE_COUNT 个 vLLM 实例:"
    for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
        port=$((BASE_PORT + i))
        echo "  GPU $i → 端口 $port"
    done
    echo ""
    read -rp "确认启动? [Y/n]: " confirm
    confirm=${confirm:-Y}
    [[ ! "$confirm" =~ ^[Yy]$ ]] && { info "已取消"; return 0; }

    # 先停止已有实例
    do_stop

    LOG_DIR="$DEPLOY_DIR/logs"
    mkdir -p "$LOG_DIR"

    STARTED=0
    for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
        port=$((BASE_PORT + i))
        LOG_FILE="$LOG_DIR/vllm_gpu${i}_$(date +%Y%m%d_%H%M%S).log"

        info "启动 GPU $i → 端口 $port ..."
        env CUDA_VISIBLE_DEVICES="$i" nohup "$VLLM_ENV_DIR/bin/python3" \
            -m vllm.entrypoints.openai.api_server \
            --model "$MODEL_PATH" --port "$port" \
            --dtype auto --max-model-len "$MAX_MODEL_LEN" \
            --gpu-memory-utilization 0.9 --trust-remote-code \
            > "$LOG_FILE" 2>&1 &
        info "  PID=$!, 日志=$LOG_FILE"
        STARTED=$((STARTED + 1))
    done

    # 等待所有端口就绪
    info "等待 $STARTED 个实例就绪..."
    ALL_READY=true
    for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
        port=$((BASE_PORT + i))
        READY=false
        for _ in $(seq 1 60); do
            if curl -s "http://localhost:$port/v1/models" >/dev/null 2>&1; then
                READY=true
                break
            fi
            sleep 5
        done
        if $READY; then
            info "  GPU $i (端口 $port) ✓"
        else
            warn "  GPU $i (端口 $port) 超时，查看日志: $LOG_DIR/vllm_gpu${i}_*.log"
            ALL_READY=false
        fi
    done

    echo ""
    if $ALL_READY; then
        echo "============================================================"
        info "$STARTED 个 vLLM 实例全部就绪"
        echo "============================================================"
    else
        warn "部分实例未就绪，请检查日志"
    fi

    # 自动注册引擎到平台
    BE_PORT=$(grep API_PORT "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "8100")
    ADMIN_PASS=$(grep SEED_ADMIN_PASSWORD "$DEPLOY_DIR/.env" 2>/dev/null | cut -d= -f2 || echo "admin123")
    PY3="$VLLM_ENV_DIR/bin/python3"
    MODEL_BASENAME=$(basename "$MODEL_PATH")

    TOKEN=$(curl -s "http://localhost:$BE_PORT/api/v1/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null \
        | "$PY3" -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

    if [ -n "$TOKEN" ]; then
        info "自动注册引擎到平台..."

        SERVICES=$(curl -s "http://localhost:$BE_PORT/api/v1/inference/services" \
            -H "Authorization: Bearer $TOKEN" 2>/dev/null)

        # 收集本次注册的引擎 ID
        ACTIVE_IDS=""

        for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
            port=$((BASE_PORT + i))
            EP="http://host.docker.internal:$port/v1"

            # 按端口查找已有引擎
            SVC_ID=$(echo "$SERVICES" | "$PY3" -c "
import sys, json
d = json.loads(sys.stdin.read() or '{}')
for s in d.get('items',[]):
    ep = s.get('endpoint') or ''
    if ':$port/' in ep:
        print(s['id']); break
" 2>/dev/null || echo "")

            if [ -n "$SVC_ID" ]; then
                curl -s -X PUT "http://localhost:$BE_PORT/api/v1/inference/services/$SVC_ID" \
                    -H "Authorization: Bearer $TOKEN" \
                    -H "Content-Type: application/json" \
                    -d "{\"endpoint\":\"$EP\",\"model_path\":\"$MODEL_PATH\",\"display_name\":\"$MODEL_BASENAME (GPU $i)\",\"status\":\"enabled\"}" >/dev/null 2>&1
                info "  更新引擎 id=$SVC_ID → GPU $i, 端口 $port (enabled)"
            else
                SVC_ID=$(curl -s -X POST "http://localhost:$BE_PORT/api/v1/inference/services" \
                    -H "Authorization: Bearer $TOKEN" \
                    -H "Content-Type: application/json" \
                    -d "{\"name\":\"vllm-port-$port\",\"display_name\":\"$MODEL_BASENAME (GPU $i)\",\"service_type\":\"gpu\",\"endpoint\":\"$EP\",\"model_path\":\"$MODEL_PATH\",\"gpu_device\":\"$i\",\"algorithms\":[\"qwen\"],\"status\":\"enabled\",\"extra_env\":{\"CUDA_VISIBLE_DEVICES\":\"$i\"}}" 2>/dev/null \
                    | "$PY3" -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
                info "  创建引擎 id=$SVC_ID → GPU $i, 端口 $port"
            fi
            ACTIVE_IDS="$ACTIVE_IDS $SVC_ID"
        done

        # disable 其他 GPU 引擎
        OTHER_IDS=$(echo "$SERVICES" | "$PY3" -c "
import sys, json
active = set('$ACTIVE_IDS'.split())
d = json.loads(sys.stdin.read() or '{}')
for s in d.get('items',[]):
    if s['service_type'] == 'gpu' and str(s['id']) not in active and s.get('status') == 'enabled':
        print(s['id'])
" 2>/dev/null)
        for oid in $OTHER_IDS; do
            curl -s -X PUT "http://localhost:$BE_PORT/api/v1/inference/services/$oid" \
                -H "Authorization: Bearer $TOKEN" \
                -H "Content-Type: application/json" \
                -d '{"status":"disabled"}' >/dev/null 2>&1
            info "  禁用多余引擎 (id=$oid)"
        done

        info "引擎注册完成 ($INSTANCE_COUNT 实例)，平台自动 round-robin 分配请求"
    else
        warn "平台未运行或登录失败，请手动注册引擎:"
        for i in $(seq 0 $((INSTANCE_COUNT - 1))); do
            port=$((BASE_PORT + i))
            echo "  GPU $i → http://host.docker.internal:$port/v1"
        done
    fi
    echo ""
}

# ─── 主逻辑 ───

echo ""
echo "============================================================"
echo "  vLLM GPU 推理服务管理"
echo "============================================================"

case "${1:-}" in
    --install)
        do_install
        ;;
    --start)
        do_start
        ;;
    --multi)
        do_start_multi
        ;;
    --stop)
        do_stop
        ;;
    --status)
        do_status
        ;;
    "")
        # 交互式: 安装 + 启动
        do_install
        do_start
        ;;
    *)
        echo "用法: $0 [--install|--start|--multi|--stop|--status]"
        echo "  --start   单实例启动（交互式）"
        echo "  --multi   多实例启动（每张 GPU 一个实例，round-robin 负载均衡）"
        exit 1
        ;;
esac
