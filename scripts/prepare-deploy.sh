#!/usr/bin/env bash
#
# 组装部署传输目录 + rsync 到目标机器
#
# 用法:
#   ./scripts/prepare-deploy.sh                                    # 交互式
#   ./scripts/prepare-deploy.sh douff@192.168.199.128              # 指定目标，其余交互
#   ./scripts/prepare-deploy.sh douff@192.168.199.128 /opt/deploy  # 全参数，无交互
#   ./scripts/prepare-deploy.sh --assemble-only                    # 只组装，不传输
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)

# 源文件
OFFLINE_PKG="${OFFLINE_PKG:-$PROJECT_DIR/dist/llm-platform-offline.tar.gz}"
MODEL_DIR="${MODEL_DIR:-}"
TEP_CSV="${TEP_CSV:-/home/douff/ts/test/tep_data_1year.csv}"
ACCEPTANCE_SCRIPT="$PROJECT_DIR/tests/acceptance/run_acceptance.py"
DEPLOY_GUIDE="$PROJECT_DIR/tests/acceptance/DEPLOY-GUIDE.md"
SDK_CLIENT="$PROJECT_DIR/backend/tests/examples/client.py"
SDK_REQUEST="$PROJECT_DIR/backend/tests/examples/analysis_request.json"
SDK_RESPONSE="$PROJECT_DIR/backend/tests/examples/analysis_response.json"

# 输出目录
DEPLOY_DIR="$PROJECT_DIR/deploy-package"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "\n${CYAN}[STEP]${NC} ${BOLD}$*${NC}"; }

echo ""
echo "============================================================"
echo "  组装部署传输目录"
echo "============================================================"

# ─── 解析参数 / 交互输入 ───

ASSEMBLE_ONLY=false
TARGET=""
REMOTE_DIR=""

if [ "${1:-}" = "--assemble-only" ]; then
    ASSEMBLE_ONLY=true
elif [ -n "${1:-}" ]; then
    TARGET="$1"
    REMOTE_DIR="${2:-}"
fi

if ! $ASSEMBLE_ONLY && [ -z "$TARGET" ]; then
    echo ""
    echo -e "${BOLD}传输配置（回车使用 [默认值]）:${NC}"
    echo ""
    read -rp "  目标机器 (user@host, 留空只组装): " TARGET
    if [ -z "$TARGET" ]; then
        ASSEMBLE_ONLY=true
    fi
fi

if ! $ASSEMBLE_ONLY && [ -z "$REMOTE_DIR" ]; then
    read -rp "  目标目录 [/opt/dff_project]: " REMOTE_DIR
    REMOTE_DIR=${REMOTE_DIR:-/opt/dff_project}
fi

# 模型路径（交互或环境变量）
if [ -z "$MODEL_DIR" ]; then
    DEFAULT_MODEL="/home/share/models/Qwen3-VL-8B-train-8192_V2_base"
    read -rp "  模型路径 [$DEFAULT_MODEL]: " MODEL_DIR
    MODEL_DIR=${MODEL_DIR:-$DEFAULT_MODEL}
fi

# ─── Step 1: 检查源文件 ───

step "1/3 检查文件"

VLLM_PKG="$PROJECT_DIR/dist/vllm-env.tar.gz"

[ -f "$OFFLINE_PKG" ] || error "离线包不存在: $OFFLINE_PKG (先运行 build-offline.sh)"
[ -d "$MODEL_DIR" ]   || error "模型目录不存在: $MODEL_DIR"
[ -f "$TEP_CSV" ]     || error "测试数据不存在: $TEP_CSV"

info "离线包:   $(du -h "$OFFLINE_PKG" | cut -f1)"
info "模型:     $(du -sh "$MODEL_DIR" | cut -f1)"
info "测试数据: $(du -h "$TEP_CSV" | cut -f1)"
if [ -f "$VLLM_PKG" ]; then
    info "vLLM 环境: $(du -h "$VLLM_PKG" | cut -f1)"
else
    warn "vLLM 环境包不存在（GPU 推理需要在目标机器手动安装）"
fi

# ─── Step 2: 组装目录 ───

step "2/3 组装目录"

mkdir -p "$DEPLOY_DIR/models"
mkdir -p "$DEPLOY_DIR/tests"

# 离线包 (硬链接，避免复制)
ln -f "$OFFLINE_PKG" "$DEPLOY_DIR/llm-platform-offline.tar.gz" 2>/dev/null \
    || cp "$OFFLINE_PKG" "$DEPLOY_DIR/llm-platform-offline.tar.gz"

# vLLM 环境包
if [ -f "$VLLM_PKG" ]; then
    ln -f "$VLLM_PKG" "$DEPLOY_DIR/vllm-env.tar.gz" 2>/dev/null \
        || cp "$VLLM_PKG" "$DEPLOY_DIR/vllm-env.tar.gz"
fi

# 测试数据
ln -f "$TEP_CSV" "$DEPLOY_DIR/tests/tep_data_1year.csv" 2>/dev/null \
    || cp "$TEP_CSV" "$DEPLOY_DIR/tests/tep_data_1year.csv"

# 验收脚本
cp "$ACCEPTANCE_SCRIPT" "$DEPLOY_DIR/tests/run_acceptance.py"

# 部署指南
cp "$DEPLOY_GUIDE" "$DEPLOY_DIR/DEPLOY-GUIDE.md"

# SDK 客户端和样例
cp "$SDK_CLIENT" "$DEPLOY_DIR/tests/sdk-client.py"
cp "$SDK_REQUEST" "$DEPLOY_DIR/tests/test-data.json"
cp "$SDK_RESPONSE" "$DEPLOY_DIR/tests/analysis_response.json"

info "目录结构:"
echo ""
echo "  deploy-package/"
echo "  ├── DEPLOY-GUIDE.md               # 部署指南"
echo "  ├── llm-platform-offline.tar.gz   # 离线包 (镜像+配置+脚本)"
[ -f "$DEPLOY_DIR/vllm-env.tar.gz" ] && \
echo "  ├── vllm-env.tar.gz              # vLLM GPU 推理环境"
echo "  ├── models/                       # → rsync 模型 (见下方)"
echo "  └── tests/"
echo "      ├── run_acceptance.py         # 验收测试脚本"
echo "      ├── sdk-client.py             # SDK 客户端"
echo "      ├── test-data.json            # API 请求样例"
echo "      ├── analysis_response.json    # API 响应样例"
echo "      └── tep_data_1year.csv        # TEP 测试数据 (165M)"

# ─── Step 3: 传输 ───

if $ASSEMBLE_ONLY; then
    echo ""
    info "组装完成: $DEPLOY_DIR"
    echo ""
    info "后续手动传输:"
    echo "  # 重新运行本脚本，输入目标地址即可传输"
    echo "  ./scripts/prepare-deploy.sh"
    echo ""
    exit 0
fi

step "3/3 rsync 传输到 $TARGET:$REMOTE_DIR"

MODEL_NAME=$(basename "$MODEL_DIR")
OFFLINE_SIZE=$(du -h "$DEPLOY_DIR/llm-platform-offline.tar.gz" | cut -f1)
VLLM_SIZE=""
[ -f "$DEPLOY_DIR/vllm-env.tar.gz" ] && VLLM_SIZE=$(du -h "$DEPLOY_DIR/vllm-env.tar.gz" | cut -f1)

echo ""
echo -e "${BOLD}传输文件确认（回车=传输，n=跳过）:${NC}"
echo ""

# 离线包
read -rp "  [1] 离线包 llm-platform-offline.tar.gz ($OFFLINE_SIZE) [Y/n]: " c1
c1=${c1:-Y}

# vLLM 环境
SEND_VLLM=false
if [ -n "$VLLM_SIZE" ]; then
    read -rp "  [2] vLLM 环境 vllm-env.tar.gz ($VLLM_SIZE) [Y/n]: " c2
    c2=${c2:-Y}
    [[ "$c2" =~ ^[Yy]$ ]] && SEND_VLLM=true
fi

# 模型
read -rp "  [3] 模型 $MODEL_NAME (~17G) [Y/n]: " c3
c3=${c3:-Y}

# 测试数据 + 指南（小文件，总是传）
echo "  [4] 测试数据 + 部署指南 (自动传输)"
echo ""

# 传输离线包
if [[ "$c1" =~ ^[Yy]$ ]]; then
    info "传输离线包..."
    rsync -avhP --mkpath "$DEPLOY_DIR/llm-platform-offline.tar.gz" "$TARGET:$REMOTE_DIR/"
else
    info "跳过离线包"
fi

# 传输 vLLM
if $SEND_VLLM; then
    info "传输 vLLM 环境..."
    rsync -avhP --mkpath "$DEPLOY_DIR/vllm-env.tar.gz" "$TARGET:$REMOTE_DIR/"
else
    info "跳过 vLLM 环境"
fi

# 传输模型
if [[ "$c3" =~ ^[Yy]$ ]]; then
    info "传输模型 $MODEL_NAME (支持断点续传)..."
    rsync -avhP --mkpath \
        "$MODEL_DIR/" \
        "$TARGET:$REMOTE_DIR/models/$MODEL_NAME/"
else
    info "跳过模型传输"
fi

# 小文件总是传
info "传输测试数据 + 部署指南..."
rsync -avhP --mkpath \
    "$DEPLOY_DIR/DEPLOY-GUIDE.md" \
    "$DEPLOY_DIR/tests" \
    "$TARGET:$REMOTE_DIR/"

# 远程校验
echo ""
info "校验目标机器文件..."
REMOTE_CHECK=$(ssh "$TARGET" "
    MISSING=0
    for f in llm-platform-offline.tar.gz DEPLOY-GUIDE.md tests/run_acceptance.py tests/tep_data_1year.csv tests/sdk-client.py models/$MODEL_NAME/config.json; do
        if [ ! -f \"$REMOTE_DIR/\$f\" ]; then
            echo \"  缺失: \$f\"
            MISSING=\$((MISSING + 1))
        fi
    done
    if [ \"\$MISSING\" -eq 0 ]; then echo 'OK'; else echo \"FAIL:\$MISSING\"; fi
" 2>/dev/null)

if [ "$REMOTE_CHECK" = "OK" ]; then
    info "远程文件校验通过"
else
    warn "远程校验发现问题:"
    echo "$REMOTE_CHECK"
fi

echo ""
echo "============================================================"
info "传输完成!"
echo "============================================================"
echo ""
info "目标机器部署:"
echo "  ssh $TARGET"
echo "  cd $REMOTE_DIR"
echo "  cat DEPLOY-GUIDE.md          # 查看部署指南"
echo "  tar xzf llm-platform-offline.tar.gz"
echo "  cd llm-platform-offline"
echo "  sudo bash scripts/deploy.sh"
echo ""
info "验收测试:"
echo "  cd $REMOTE_DIR"
echo "  python tests/run_acceptance.py --csv tests/tep_data_1year.csv"
echo ""
