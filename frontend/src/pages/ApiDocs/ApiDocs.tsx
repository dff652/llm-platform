import { useState, useEffect } from 'react';
import styles from './ApiDocs.module.css';

interface ModelInfo {
  id: string;
  object: string;
}

export default function ApiDocs() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    setBaseUrl(window.location.origin);
    // Fetch models directly (bypasses /api/v1 prefix)
    const token = localStorage.getItem('token');
    if (token) {
      fetch('/v1/models', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => setModels(data.data || []))
        .catch(() => {});
    }
  }, []);

  const modelName = models[0]?.id || 'your-model-name';

  return (
    <div className={styles.page}>
      <h2>API 文档</h2>
      <p className={styles.subtitle}>
        本平台提供 OpenAI 兼容 API，可使用任何 OpenAI SDK 或 HTTP 客户端与模型交互。
      </p>

      {/* Quick start */}
      <section className={styles.section}>
        <h3>快速开始</h3>
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepNum}>1</span>
            <div>
              <strong>获取 API Key</strong>
              <p>前往 <a href="/api-keys">API 密钥</a> 页面创建密钥。</p>
            </div>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>2</span>
            <div>
              <strong>选择模型</strong>
              <p>可用模型：{models.length > 0
                ? models.map((m) => <code key={m.id} className={styles.code}>{m.id}</code>)
                : <span className={styles.muted}>暂未注册模型</span>
              }</p>
            </div>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>3</span>
            <div>
              <strong>发送请求</strong>
              <p>参考以下示例。</p>
            </div>
          </div>
        </div>
      </section>

      {/* Endpoints */}
      <section className={styles.section}>
        <h3>端点列表</h3>
        <table className={styles.table}>
          <thead>
            <tr><th>方法</th><th>路径</th><th>描述</th></tr>
          </thead>
          <tbody>
            <tr><td><span className={styles.method}>POST</span></td><td><code>/v1/chat/completions</code></td><td>聊天补全（推荐）</td></tr>
            <tr><td><span className={styles.method}>POST</span></td><td><code>/v1/completions</code></td><td>文本补全（旧版）</td></tr>
            <tr><td><span className={styles.methodGet}>GET</span></td><td><code>/v1/models</code></td><td>列出可用模型</td></tr>
          </tbody>
        </table>
      </section>

      {/* cURL example */}
      <section className={styles.section}>
        <h3>cURL</h3>
        <CodeBlock language="bash">{`curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelName}",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "max_tokens": 512,
    "temperature": 0.7
  }'`}</CodeBlock>
      </section>

      {/* Python example */}
      <section className={styles.section}>
        <h3>Python（OpenAI SDK）</h3>
        <CodeBlock language="python">{`from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${baseUrl}/v1",
)

response = client.chat.completions.create(
    model="${modelName}",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"},
    ],
    max_tokens=512,
    temperature=0.7,
)
print(response.choices[0].message.content)`}</CodeBlock>
      </section>

      {/* Streaming example */}
      <section className={styles.section}>
        <h3>流式调用（Python）</h3>
        <CodeBlock language="python">{`stream = client.chat.completions.create(
    model="${modelName}",
    messages=[{"role": "user", "content": "Tell me a story"}],
    stream=True,
)
for chunk in stream:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)`}</CodeBlock>
      </section>

      {/* Authentication */}
      <section className={styles.section}>
        <h3>认证方式</h3>
        <p>所有请求需通过 <code>Authorization</code> 头认证：</p>
        <CodeBlock language="text">{`Authorization: Bearer ak-xxxxxxxxxxxxxxxx`}</CodeBlock>
        <p className={styles.muted}>
          支持 API Key（前缀 <code>ak-</code>）和 JWT 令牌。程序化访问推荐使用 API Key。
        </p>
      </section>

      {/* Rate limiting */}
      <section className={styles.section}>
        <h3>速率限制</h3>
        <p>每个 API Key 可配置速率限制（每分钟/小时/天）。超过限制时返回：</p>
        <CodeBlock language="json">{`HTTP 429 Too Many Requests
{
  "detail": "Rate limit exceeded (minute: 60/window)"
}

Headers:
  Retry-After: 45
  X-RateLimit-Window: minute
  X-RateLimit-Limit: 60
  X-RateLimit-Remaining: 0`}</CodeBlock>
      </section>

      {/* Response format */}
      <section className={styles.section}>
        <h3>响应格式</h3>
        <CodeBlock language="json">{`{
  "id": "chatcmpl-abc123...",
  "object": "chat.completion",
  "model": "${modelName}",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 8,
    "total_tokens": 33
  }
}`}</CodeBlock>
      </section>
    </div>
  );
}

function CodeBlock({ children, language }: { children: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>{language}</span>
        <button className={styles.copyBtn} onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className={styles.pre}><code>{children}</code></pre>
    </div>
  );
}
