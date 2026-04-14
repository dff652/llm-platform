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
      <h2>API Documentation</h2>
      <p className={styles.subtitle}>
        This platform provides an OpenAI-compatible API. Use any OpenAI SDK or HTTP client to interact with your models.
      </p>

      {/* Quick start */}
      <section className={styles.section}>
        <h3>Quick Start</h3>
        <div className={styles.steps}>
          <div className={styles.step}>
            <span className={styles.stepNum}>1</span>
            <div>
              <strong>Get an API Key</strong>
              <p>Go to <a href="/api-keys">API Keys</a> page and create a key.</p>
            </div>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>2</span>
            <div>
              <strong>Choose a Model</strong>
              <p>Available models: {models.length > 0
                ? models.map((m) => <code key={m.id} className={styles.code}>{m.id}</code>)
                : <span className={styles.muted}>No models registered yet</span>
              }</p>
            </div>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNum}>3</span>
            <div>
              <strong>Make a Request</strong>
              <p>Use the examples below.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Endpoints */}
      <section className={styles.section}>
        <h3>Endpoints</h3>
        <table className={styles.table}>
          <thead>
            <tr><th>Method</th><th>Path</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td><span className={styles.method}>POST</span></td><td><code>/v1/chat/completions</code></td><td>Chat completions (recommended)</td></tr>
            <tr><td><span className={styles.method}>POST</span></td><td><code>/v1/completions</code></td><td>Text completions (legacy)</td></tr>
            <tr><td><span className={styles.methodGet}>GET</span></td><td><code>/v1/models</code></td><td>List available models</td></tr>
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
        <h3>Python (OpenAI SDK)</h3>
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
        <h3>Streaming (Python)</h3>
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
        <h3>Authentication</h3>
        <p>All requests require authentication via the <code>Authorization</code> header:</p>
        <CodeBlock language="text">{`Authorization: Bearer ak-xxxxxxxxxxxxxxxx`}</CodeBlock>
        <p className={styles.muted}>
          Both API Keys (prefix <code>ak-</code>) and JWT tokens are supported.
          API Keys are recommended for programmatic access.
        </p>
      </section>

      {/* Rate limiting */}
      <section className={styles.section}>
        <h3>Rate Limiting</h3>
        <p>Each API Key has configurable rate limits (per minute / hour / day). When exceeded, the API returns:</p>
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
        <h3>Response Format</h3>
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
