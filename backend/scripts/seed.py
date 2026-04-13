"""Seed script: create initial admin user if none exists.

Usage:
    cd backend
    python -m scripts.seed
"""

import asyncio
import sys
from pathlib import Path

# Add backend to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import async_session, Base, engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.inference_service import InferenceService  # noqa: E402
from app.models.pipeline_profile import PipelineProfile  # noqa: E402
from app.models.model_entity import ModelEntity  # noqa: E402
from app.models.config_template import InferenceConfigTemplate  # noqa: E402
import app.models  # noqa: E402, F401
from sqlalchemy import select  # noqa: E402
from app.algorithms.registry import get_direct_methods, get_vllm_methods  # noqa: E402


import os  # noqa: E402
import secrets  # noqa: E402
import json  # noqa: E402

ADMIN_USERNAME = os.environ.get("SEED_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin123")
SEED_API_KEY_COUNT = int(os.environ.get("SEED_API_KEY_COUNT", "10"))

# GPU 引擎不在 seed 中创建 — 由 start-vllm.sh 启动时自动注册。
# 只 seed CPU 算法池，确保基础算法始终可用。
DEFAULT_SERVICES = [
    {
        "name": "cpu-pool",
        "display_name": "CPU 算法池",
        "service_type": "cpu",
        "endpoint": None,
        "model_name": None,
        "gpu_device": None,
        "algorithms": sorted(m for m in get_direct_methods() if m not in ("piecewise_linear", "iforest")),
        "description": "传统 CPU 异常检测算法集合",
    },
]


async def seed():
    # Ensure tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as db:
        # Seed admin user
        result = await db.execute(
            select(User).where(User.username == ADMIN_USERNAME)
        )
        existing = result.scalar_one_or_none()

        if existing:
            print(f"Admin user '{ADMIN_USERNAME}' already exists (id={existing.id})")
        else:
            admin = User(
                username=ADMIN_USERNAME,
                password_hash=hash_password(ADMIN_PASSWORD),
                display_name="管理员",
                role="admin",
                status="active",
            )
            db.add(admin)
            print(f"Created admin user: {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
            print("!! Please change the default password after first login !!")

        # Seed default services
        for svc_data in DEFAULT_SERVICES:
            result = await db.execute(
                select(InferenceService).where(InferenceService.name == svc_data["name"])
            )
            existing_svc = result.scalar_one_or_none()
            if existing_svc:
                print(f"Service '{svc_data['name']}' already exists (id={existing_svc.id})")
                continue

            svc = InferenceService(
                created_by="admin",
                status="enabled",
                **svc_data,
            )
            db.add(svc)
            print(f"Created service: {svc_data['name']} ({svc_data['service_type']})")

        # Seed default pipeline profiles
        await _seed_profiles(db)

        await db.commit()

    # --- 种子模型数据 ---
    await seed_models()

    # --- 种子配置数据 ---
    await seed_configs()

    # --- 种子 API Key ---
    await seed_api_keys()


# 预置模型列表
SEED_MODELS = [
    # GPU 模型
    {
        "name": "Qwen3-VL-8B-train-8192_V2_base",
        "family": "qwen",
        "runtime_type": "vllm",
        "version": "3.0",
        "artifact_uri": "/home/share/llm_models/Qwen/Qwen3-VL-8B-Instruct",
        "description": "Qwen3-VL 多模态大模型，支持时序图像异常检测",
        "status": "active",
    },
    {
        "name": "ChatTS-14B",
        "family": "chatts",
        "runtime_type": "transformers",
        "version": "1.0",
        "artifact_uri": "/home/share/llm_models/bytedance-research/ChatTS-14B",
        "description": "ChatTS-14B 时间序列对话模型",
        "status": "active",
    },
    # CPU 模型
    {
        "name": "ADTK-HBOS",
        "family": "adtk_hbos",
        "runtime_type": "cpu",
        "version": "1.0",
        "description": "基于直方图的离群值检测（HBOS）",
        "status": "active",
    },
    {
        "name": "Isolation Forest",
        "family": "isolation_forest",
        "runtime_type": "cpu",
        "version": "1.0",
        "description": "孤立森林异常检测算法",
        "status": "active",
    },
    {
        "name": "Ensemble",
        "family": "ensemble",
        "runtime_type": "cpu",
        "version": "1.0",
        "description": "多方法投票集成异常检测",
        "status": "active",
    },
    {
        "name": "Wavelet",
        "family": "wavelet",
        "runtime_type": "cpu",
        "version": "1.0",
        "description": "小波分解异常检测",
        "status": "active",
    },
    {
        "name": "STL-Wavelet",
        "family": "stl_wavelet",
        "runtime_type": "cpu",
        "version": "1.0",
        "description": "STL季节分解 + 小波分析",
        "status": "active",
    },
]


async def seed_models():
    """幂等插入预置模型。"""
    async with async_session() as db:
        for model_data in SEED_MODELS:
            result = await db.execute(
                select(ModelEntity).where(ModelEntity.name == model_data["name"])
            )
            if result.scalar_one_or_none():
                print(f"  Model '{model_data['name']}' already exists, skipping")
                continue
            db.add(ModelEntity(**model_data))
            print(f"  Created model: {model_data['name']} ({model_data['family']})")
        await db.commit()
    print(f"Seed models done: {len(SEED_MODELS)} defined")


# 预置配置模板（完整 ConfigPipeline 格式，键名 camelCase 与前端类型一致）
SEED_CONFIGS = [
    {
        "name": "Qwen 默认配置",
        "algorithm_id": "2",
        "algorithm_name": "qwen",
        "enabled": True,
        "resource_profile": "gpu",
        "default_params": {
            "preprocess": {
                "method": "m4",
                "params": {"target": 5000, "normalization": "none"},
                "features": [],
            },
            "inference": {
                "baseModelPath": "/opt/llm_models/qwen/Qwen3-VL-8B-Instruct",
                "device": "cuda:0",
                "quantization": "none",
                "promptTemplate": "default",
                "temperature": 0.1,
            },
            "alignment": {
                "targetFormat": "interval",
                "qualityGate": "reviewed",
                "outputPath": "./app/data/pool/qwen",
                "autoFlow": False,
                "mappings": [
                    {"from": "normal", "to": "正常"},
                    {"from": "anomaly", "to": "异常"},
                    {"from": "leak", "to": "泄漏"},
                ],
                "confidenceThreshold": 0.7,
                "minIntervalLength": 5,
                "smoothWindow": 3,
                "lowConfidenceAction": "review",
                "highConfidenceAction": "auto",
            },
            "evolution": {
                "triggerThreshold": 200,
                "method": "lora",
                "trainParams": {
                    # 基础 LoRA 参数（对齐 ilabel qwen3-vl-8B-test/training/train.sh 实测值）
                    "loraRank": 16,
                    "loraAlpha": 16,
                    "targetModules": "all7",
                    "dropout": 0.1,
                    "learningRate": 0.0001,
                    "batchSize": 1,  # 24GB GPU 需要 batch=1 防 OOM
                    "epochs": 3,
                    "warmupRatio": 0.0,
                    "cutoffLen": 4096,  # 数据最长 ~2633 tokens，4096 零截断且省显存
                    "bf16": True,
                    "gradientAccumulationSteps": 16,  # 配合 batch=1 保持有效 batch size
                    "lrSchedulerType": "cosine",
                    "gradientCheckpointing": True,
                    "loggingSteps": 1,
                    "saveSteps": 10,
                    # LoRA+ / rsLoRA（提升收敛速度）
                    "loraplusLrRatio": 8,
                    "useRslora": True,
                    # 优化器与梯度
                    "optim": "adamw_bnb_8bit",
                    "maxGradNorm": 1.0,
                    # 验证集
                    "valSize": 0.1,
                    # Qwen-VL 视觉参数（解冻 vision tower + 高分辨率图像）
                    "freezeVisionTower": False,
                    "freezeMultiModalProjector": False,
                    "imageMaxPixels": 800000,
                    "imageMinPixels": 1024,
                },
                "triggerMode": "manual",
            },
        },
    },
]


async def seed_configs():
    """幂等插入或更新预置配置模板。已存在的记录会更新 default_params。"""
    async with async_session() as db:
        # 清理已废弃的配置（ChatTS 已取消，聚焦 Qwen）
        deprecated = ["ChatTS 默认配置", "ChatTS-8B 默认配置"]
        for name in deprecated:
            result = await db.execute(
                select(InferenceConfigTemplate).where(
                    InferenceConfigTemplate.name == name
                )
            )
            old = result.scalar_one_or_none()
            if old:
                await db.delete(old)
                print(f"  Removed deprecated config: '{name}' (id={old.id})")

        for config_data in SEED_CONFIGS:
            result = await db.execute(
                select(InferenceConfigTemplate).where(
                    InferenceConfigTemplate.name == config_data["name"]
                )
            )
            existing = result.scalar_one_or_none()
            if existing:
                # 更新已有记录的配置字段
                existing.default_params = config_data["default_params"]
                existing.algorithm_id = config_data.get("algorithm_id", existing.algorithm_id)
                existing.algorithm_name = config_data.get("algorithm_name", existing.algorithm_name)
                existing.enabled = config_data.get("enabled", existing.enabled)
                existing.resource_profile = config_data.get("resource_profile", existing.resource_profile)
                print(f"  Config '{config_data['name']}' updated (id={existing.id})")
                continue
            db.add(InferenceConfigTemplate(**config_data))
            print(f"  Created config: {config_data['name']}")
        await db.commit()
    print(f"Seed configs done: {len(SEED_CONFIGS)} defined")


DEFAULT_PROFILES = [
    {
        "name": "Qwen-默认",
        "algorithm": "qwen",
        "description": "Qwen-VL 视觉推理默认方案",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 5000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {
            "prompt_template": "default",
            "max_tokens": 512,
            "temperature": 0.1,
        },
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "Qwen-工业",
        "algorithm": "qwen",
        "description": "Qwen-VL 工业场景方案，使用工业 prompt 和更大合并间距",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 5000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {
            "prompt_template": "industrial",
            "max_tokens": 512,
            "temperature": 0.1,
        },
        "postprocess_config": {"merge_gap": 10},
    },
    {
        "name": "ChatTS-默认",
        "algorithm": "chatts",
        "description": "ChatTS-8B 时序推理默认方案",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 768,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {
            "prompt_template": "default",
            "max_tokens": 2048,
            "temperature": 0.1,
        },
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "STL-Wavelet-默认",
        "algorithm": "stl_wavelet",
        "description": "STL 分解 + 小波检测，适用于有季节性的数据",
        "preprocess_config": {
            "fill_missing": True,
            "fill_method": "ffill",
            "downsampler": "m4",
            "n_downsample": 10000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {
            "threshold": 5.0,
            "decompose": True,
            "stl_period": 60,
            "use_trend": False,
            "use_seasonal": False,
            "use_resid": True,
        },
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "ADTK-HBOS-默认",
        "algorithm": "adtk_hbos",
        "description": "统计异常检测，适用于突变和均值漂移",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 10000,
            "sample_mode": "ratio",
            "sample_ratio": 0.1,
            "detect_data_type": False,
        },
        "method_config": {"bin_nums": 20},
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "Ensemble-默认",
        "algorithm": "ensemble",
        "description": "分段线性拟合 + IQR 检测",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 5000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {"threshold": 1.5},
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "IForest-默认",
        "algorithm": "isolation_forest",
        "description": "孤立森林异常检测",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 5000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {"threshold": 0.01},
        "postprocess_config": {"merge_gap": 5},
    },
    {
        "name": "Wavelet-默认",
        "algorithm": "wavelet",
        "description": "小波分解异常检测",
        "preprocess_config": {
            "fill_missing": False,
            "downsampler": "m4",
            "n_downsample": 5000,
            "sample_mode": "fixed",
            "detect_data_type": True,
            "skip_on_step": False,
            "skip_on_noise": False,
        },
        "method_config": {"threshold": 5.0},
        "postprocess_config": {"merge_gap": 5},
    },
]


async def _seed_profiles(db):
    """Seed system pipeline profiles (idempotent)."""
    for profile_data in DEFAULT_PROFILES:
        result = await db.execute(
            select(PipelineProfile).where(
                PipelineProfile.name == profile_data["name"],
                PipelineProfile.is_system == True,  # noqa: E712
            )
        )
        existing = result.scalar_one_or_none()
        if existing:
            print(f"Profile '{profile_data['name']}' already exists (id={existing.id})")
            continue

        profile = PipelineProfile(
            is_system=True,
            created_by="system",
            **profile_data,
        )
        db.add(profile)
        print(f"Created profile: {profile_data['name']} ({profile_data['algorithm']})")


async def seed_api_keys():
    """生成 API Key 并保存到文件，供外部系统使用。"""
    import bcrypt
    from app.models.api_key import ApiKey

    api_keys_file = Path(__file__).resolve().parent.parent / "data" / "api_keys.json"

    async with async_session() as db:
        # 检查是否已有 key
        result = await db.execute(select(ApiKey))
        existing = result.scalars().all()
        if existing:
            print(f"API keys already exist ({len(existing)} keys), skipping")
            return

        # 获取 admin 用户 ID
        result = await db.execute(select(User).where(User.username == ADMIN_USERNAME))
        admin = result.scalar_one_or_none()
        if not admin:
            print("Admin user not found, skipping API key generation")
            return

        generated_keys = []
        for i in range(SEED_API_KEY_COUNT):
            raw_key = f"ak-{secrets.token_hex(16)}"
            prefix = raw_key[:10]
            key_hash = bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

            api_key = ApiKey(
                name=f"系统集成密钥-{i+1:02d}",
                key_prefix=prefix,
                key_hash=key_hash,
                user_id=admin.id,
                is_active=True,
            )
            db.add(api_key)
            generated_keys.append({
                "name": api_key.name,
                "key": raw_key,
                "prefix": prefix,
            })

        await db.commit()

    # 保存到文件
    api_keys_file.parent.mkdir(parents=True, exist_ok=True)
    with open(api_keys_file, "w") as f:
        json.dump(generated_keys, f, indent=2, ensure_ascii=False)

    print(f"Generated {len(generated_keys)} API keys → {api_keys_file}")
    for k in generated_keys[:3]:
        print(f"  {k['name']}: {k['key']}")
    if len(generated_keys) > 3:
        print(f"  ... 共 {len(generated_keys)} 个，完整列表见 {api_keys_file}")


if __name__ == "__main__":
    asyncio.run(seed())
