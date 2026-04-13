#!/usr/bin/env bash
#
# 打包 vLLM conda 环境（普通用户执行，不需要 sudo）
#
# 用法:
#   ./scripts/pack-vllm.sh              # 打包 vLLM 环境
#   ./scripts/pack-vllm.sh --force      # 强制重新打包（忽略缓存）
#
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR=$(pwd)
DIST_DIR="$PROJECT_DIR/dist"

VLLM_ENV_NAME="${VLLM_ENV_NAME:-vllm}"
VLLM_PKG="$DIST_DIR/vllm-env.tar.gz"
FORCE="${1:-}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

echo ""
echo "============================================================"
echo "  vLLM 环境打包"
echo "============================================================"
echo ""

# 检查缓存
if [ -f "$VLLM_PKG" ] && [ "$FORCE" != "--force" ]; then
    info "vLLM 环境包已存在: $VLLM_PKG ($(du -h "$VLLM_PKG" | cut -f1))"
    info "使用 --force 强制重新打包"
    exit 0
fi

# 检查 conda 环境
if ! conda env list 2>/dev/null | grep -q "$VLLM_ENV_NAME"; then
    error "conda 环境 '$VLLM_ENV_NAME' 不存在"
fi

# 确保依赖安装在 conda 环境内（不是 ~/.local）
# conda-pack 只打包环境目录内的文件
info "确保依赖安装在 conda 环境内..."
VLLM_SITE_PACKAGES=$(conda run -n "$VLLM_ENV_NAME" python -c "import site; print([p for p in site.getsitepackages() if '$VLLM_ENV_NAME' in p][0])" 2>/dev/null || echo "")
REINSTALL=""
for dep in click jinja2 uvloop httptools; do
    DEP_PATH=$(conda run -n "$VLLM_ENV_NAME" python -c "import $dep; print($dep.__file__)" 2>/dev/null || echo "")
    if [ -z "$DEP_PATH" ] || ! echo "$DEP_PATH" | grep -q "$VLLM_ENV_NAME"; then
        REINSTALL="$REINSTALL $dep"
    fi
done

if [ -n "$REINSTALL" ]; then
    info "以下依赖不在 conda 环境内，重新安装:$REINSTALL"
    conda run -n "$VLLM_ENV_NAME" pip install --force-reinstall $REINSTALL
fi

# 确保 conda-pack 可用
if ! conda run -n "$VLLM_ENV_NAME" python -c "import conda_pack" 2>/dev/null; then
    info "安装 conda-pack..."
    conda run -n "$VLLM_ENV_NAME" pip install conda-pack
fi

# 验证 vLLM
VLLM_VER=$(conda run -n "$VLLM_ENV_NAME" python -c "import vllm; print(vllm.__version__)" 2>/dev/null || echo "")
PY_VER=$(conda run -n "$VLLM_ENV_NAME" python --version 2>/dev/null | grep -oP '\d+\.\d+' || echo "?")
if [ -z "$VLLM_VER" ]; then
    error "vLLM 未安装在 $VLLM_ENV_NAME 环境中"
fi
info "vLLM $VLLM_VER / Python $PY_VER"

if [ "$PY_VER" != "3.11" ]; then
    warn "Python 版本 $PY_VER，推荐 3.11（渲染一致性）"
fi

# 打包
mkdir -p "$DIST_DIR"
info "conda-pack 打包中（约 5 分钟）..."
conda run -n "$VLLM_ENV_NAME" conda-pack -n "$VLLM_ENV_NAME" -o "$VLLM_PKG" --force

SIZE=$(du -h "$VLLM_PKG" | cut -f1)

# 验证打包产物（通过 tar 索引检查，不解压）
info "验证打包产物..."
VERIFY_OK=true

for f in bin/python3 bin/pip lib/python3.11/site-packages/vllm/__init__.py lib/python3.11/site-packages/torch/__init__.py lib/python3.11/site-packages/click/__init__.py lib/python3.11/site-packages/jinja2/__init__.py; do
    if ! tar tzf "$VLLM_PKG" "$f" >/dev/null 2>&1; then
        warn "打包缺失: $f"
        VERIFY_OK=false
    fi
done

if $VERIFY_OK; then
    info "打包验证通过：关键文件和依赖完整"
else
    error "打包验证失败！请检查 conda 环境后重新运行: $0 --force"
fi

echo ""
echo "============================================================"
info "vLLM 环境打包完成: $VLLM_PKG ($SIZE)"
info "依赖验证: vllm, torch, click, jinja2, uvloop, httptools, transformers ✓"
echo "============================================================"
echo ""
info "下一步: sudo ./scripts/build-offline.sh"
