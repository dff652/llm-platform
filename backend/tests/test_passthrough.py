"""透传完整性测试 — 验证 /v1/chat/completions 把客户端字段正确转发给 vLLM。

聚焦 ChatCompletionRequest schema + openai_api.chat_completions 中的 payload
构造逻辑（openai_api.py L138-140）。

不走 FastAPI / DB / 真 vLLM —— 这层逻辑是「请求体 → vLLM payload」的纯转换，
单元测试就够；端到端集成测试需要 fake vLLM，留待后续。

对照 docs/gateway-stability-strategy.md §阶段 1 的 4 类字段：
  1. extra_body.{guided_json, guided_regex, guided_choice}  vLLM 原生约束解码
  2. tools / tool_choice                                     OpenAI Function Calling
  3. response_format                                         OpenAI Structured Output
  4. n / seed / temperature                                  采样控制（self_consistency 类技术依赖）
"""

import pytest

from app.schemas.openai import ChatCompletionRequest


def _build_payload(body: ChatCompletionRequest) -> dict:
    """复刻 openai_api.chat_completions L138-140 的 payload 构造。

    任何对该逻辑的修改必须同步本函数，否则测试无法保护。
    TODO: 把这段提取到 services/llm_router.py 共享，然后 endpoint 和测试都 import。
    """
    payload = body.model_dump(exclude_none=True, exclude={"extra_body"})
    if body.extra_body:
        payload.update(body.extra_body)
    return payload


# ---------------------------------------------------------------------------
# 类 1：extra_body 透传（vLLM 原生约束解码）
# ---------------------------------------------------------------------------

ANOMALY_SCHEMA = {
    "type": "object",
    "properties": {
        "detected_anomalies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "interval": {"type": "array", "items": {"type": "integer"}},
                    "type": {"type": "string"},
                },
                "required": ["interval", "type"],
            },
        }
    },
    "required": ["detected_anomalies"],
}


def test_extra_body_guided_json_flattened():
    """extra_body.guided_json 应展平到 payload 顶层（OpenAI SDK 约定）。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-vl-7b",
        "messages": [{"role": "user", "content": "detect anomalies"}],
        "extra_body": {"guided_json": ANOMALY_SCHEMA},
    })
    payload = _build_payload(body)

    assert "extra_body" not in payload, "extra_body 字段本身不应进 payload"
    assert payload["guided_json"] == ANOMALY_SCHEMA, "guided_json 应展平到顶层且内容完整"


def test_extra_body_guided_regex_flattened():
    """extra_body.guided_regex 同样展平。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "extract"}],
        "extra_body": {"guided_regex": r"\d{4}-\d{2}-\d{2}"},
    })
    payload = _build_payload(body)
    assert payload["guided_regex"] == r"\d{4}-\d{2}-\d{2}"


def test_extra_body_guided_choice_flattened():
    """extra_body.guided_choice 同样展平（vLLM 枚举约束）。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "classify"}],
        "extra_body": {"guided_choice": ["positive", "negative", "neutral"]},
    })
    payload = _build_payload(body)
    assert payload["guided_choice"] == ["positive", "negative", "neutral"]


def test_extra_body_multiple_keys():
    """extra_body 多个 key 全部展平，不丢字段。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "extra_body": {
            "guided_json": ANOMALY_SCHEMA,
            "guided_decoding_backend": "xgrammar",
            "min_tokens": 10,
        },
    })
    payload = _build_payload(body)
    assert payload["guided_json"] == ANOMALY_SCHEMA
    assert payload["guided_decoding_backend"] == "xgrammar"
    assert payload["min_tokens"] == 10


def test_no_extra_body_does_not_inject_keys():
    """没传 extra_body 时 payload 不应有 guided_json 等字段。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "hi"}],
    })
    payload = _build_payload(body)
    assert "guided_json" not in payload
    assert "extra_body" not in payload


# ---------------------------------------------------------------------------
# 类 2：OpenAI 标准 Function Calling 字段（tools / tool_choice）
# ---------------------------------------------------------------------------

SAMPLE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_order",
            "description": "Query order by id and product",
            "parameters": {
                "type": "object",
                "properties": {
                    "order_id": {"type": "string"},
                    "product_name": {"type": "string"},
                },
                "required": ["order_id"],
            },
        },
    }
]


def test_tools_passthrough_top_level():
    """客户端在顶层传 tools（非 extra_body 路径）→ payload 保留。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "查订单 ABC"}],
        "tools": SAMPLE_TOOLS,
        "tool_choice": "auto",
    })
    payload = _build_payload(body)
    assert payload["tools"] == SAMPLE_TOOLS, "tools 应通过 extra=allow 透传"
    assert payload["tool_choice"] == "auto"


def test_tool_choice_specific_function():
    """tool_choice 可以指定具体函数（dict 形式）。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "tools": SAMPLE_TOOLS,
        "tool_choice": {"type": "function", "function": {"name": "query_order"}},
    })
    payload = _build_payload(body)
    assert payload["tool_choice"]["function"]["name"] == "query_order"


# ---------------------------------------------------------------------------
# 类 3：OpenAI Structured Output（response_format）
# ---------------------------------------------------------------------------

def test_response_format_json_schema_passthrough():
    """response_format: json_schema strict 模式应透传。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "anomalies",
                "strict": True,
                "schema": ANOMALY_SCHEMA,
            },
        },
    })
    payload = _build_payload(body)
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert payload["response_format"]["json_schema"]["schema"] == ANOMALY_SCHEMA


def test_response_format_json_object_passthrough():
    """response_format: json_object（旧版 JSON mode）也应透传。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "response_format": {"type": "json_object"},
    })
    payload = _build_payload(body)
    assert payload["response_format"] == {"type": "json_object"}


# ---------------------------------------------------------------------------
# 类 4：采样控制（self_consistency / 复现需要）
# ---------------------------------------------------------------------------

def test_n_seed_temperature_passthrough():
    """n / seed / temperature 是已声明字段，必须透传。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "n": 5,
        "temperature": 0.8,
        "top_p": 0.95,
    })
    payload = _build_payload(body)
    assert payload["n"] == 5
    assert payload["temperature"] == 0.8
    assert payload["top_p"] == 0.95


def test_seed_passthrough_via_extra_allow():
    """seed 不在 ChatCompletionRequest 显式字段里，靠 extra=allow 透传。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-7b",
        "messages": [{"role": "user", "content": "x"}],
        "seed": 42,
    })
    payload = _build_payload(body)
    assert payload["seed"] == 42, "seed 应通过 extra=allow 透传，复现实验依赖此"


# ---------------------------------------------------------------------------
# 边界：vLLM 多模态消息（image_url 等）
# ---------------------------------------------------------------------------

def test_vl_message_with_image_passthrough():
    """ChatMessage.content 支持 list[dict]（多模态），image_url 等应保留。"""
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-vl-7b",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "描述这张图"},
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/png;base64,iVBORw0KG..."},
                    },
                ],
            }
        ],
    })
    payload = _build_payload(body)
    content = payload["messages"][0]["content"]
    assert isinstance(content, list)
    assert content[0]["type"] == "text"
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


# ---------------------------------------------------------------------------
# 综合：ts-lab guided_json technique 完整请求形态
# ---------------------------------------------------------------------------

def test_ts_lab_guided_json_full_payload():
    """模拟 ts-lab guided_json technique 调用 llm-platform 的完整请求。

    这是 docs/gateway-stability-strategy.md §阶段 2 的预期使用形态。
    """
    body = ChatCompletionRequest.model_validate({
        "model": "qwen-vl-7b",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Detect anomalies in this time series chart."},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
                ],
            }
        ],
        "temperature": 0.1,
        "max_tokens": 512,
        "seed": 42,
        "extra_body": {"guided_json": ANOMALY_SCHEMA},
    })
    payload = _build_payload(body)

    # 业务字段
    assert payload["model"] == "qwen-vl-7b"
    assert payload["temperature"] == 0.1
    assert payload["max_tokens"] == 512
    # 复现字段
    assert payload["seed"] == 42
    # 约束解码字段
    assert payload["guided_json"] == ANOMALY_SCHEMA
    # 多模态内容
    assert len(payload["messages"][0]["content"]) == 2
    # 不该残留 extra_body 包装
    assert "extra_body" not in payload
