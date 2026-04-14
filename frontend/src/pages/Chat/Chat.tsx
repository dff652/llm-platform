import { useState, useEffect, useRef, useCallback } from 'react';
import { useUiStore } from '../../stores/uiStore';
import styles from './Chat.module.css';

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ModelOption {
  id: string;
}

export default function Chat() {
  const showToast = useUiStore((s) => s.showToast);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [showParams, setShowParams] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [systemPrompt, setSystemPrompt] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch available models
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;
    fetch('/v1/models', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        const list: ModelOption[] = (data.data || []).map((m: { id: string }) => ({ id: m.id }));
        setModels(list);
        if (list.length > 0 && !selectedModel) setSelectedModel(list[0]!.id);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamContent]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || !selectedModel) return;

    const userMsg: Message = { role: 'user', content: text };
    const allMessages = [...messages, userMsg];

    // Build messages array with optional system prompt
    const apiMessages: Message[] = [];
    if (systemPrompt.trim()) {
      apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    }
    apiMessages.push(...allMessages);

    setMessages(allMessages);
    setInput('');
    setStreaming(true);
    setStreamContent('');

    const controller = new AbortController();
    abortRef.current = controller;

    const token = localStorage.getItem('token');
    let fullContent = '';

    try {
      const resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err);
      }

      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));

              // Streaming chunk format (delta)
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                fullContent += delta;
                setStreamContent(fullContent);
                continue;
              }

              // Non-streaming fallback (full message)
              const content = json.choices?.[0]?.message?.content;
              if (content) {
                fullContent = content;
                setStreamContent(fullContent);
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        // User cancelled
      } else {
        const msg = e instanceof Error ? e.message : 'Request failed';
        showToast({ type: 'error', message: msg.slice(0, 200) });
      }
    } finally {
      if (fullContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: fullContent }]);
      }
      setStreamContent('');
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, selectedModel, messages, temperature, maxTokens, systemPrompt, showToast]);

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClear = () => {
    if (streaming) return;
    setMessages([]);
    setStreamContent('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.page}>
      {/* Header bar */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <select
            className={styles.modelSelect}
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={streaming}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
            {models.length === 0 && <option value="">No models available</option>}
          </select>
          <button
            className={`${styles.paramToggle} ${showParams ? styles.paramToggleActive : ''}`}
            onClick={() => setShowParams(!showParams)}
            title="Parameters"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 4h12M2 8h12M2 12h12" />
              <circle cx="5" cy="4" r="1.5" fill="currentColor" />
              <circle cx="10" cy="8" r="1.5" fill="currentColor" />
              <circle cx="7" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </button>
        </div>
        <button className={styles.clearBtn} onClick={handleClear} disabled={streaming || messages.length === 0}>
          Clear
        </button>
      </div>

      {/* Parameter panel */}
      {showParams && (
        <div className={styles.paramPanel}>
          <label>
            <span>Temperature: {temperature}</span>
            <input type="range" min="0" max="2" step="0.1" value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))} />
          </label>
          <label>
            <span>Max Tokens: {maxTokens}</span>
            <input type="range" min="64" max="4096" step="64" value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value))} />
          </label>
          <label>
            <span>System Prompt</span>
            <textarea
              className={styles.systemInput}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={2}
            />
          </label>
        </div>
      )}

      {/* Messages */}
      <div className={styles.messages}>
        {messages.length === 0 && !streamContent && (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="6" y="10" width="36" height="28" rx="4" />
                <path d="M14 20h8M14 26h20" />
              </svg>
            </div>
            <p>Select a model and start chatting</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`${styles.msgRow} ${msg.role === 'user' ? styles.msgUser : styles.msgAssistant}`}>
            <div className={styles.msgAvatar}>
              {msg.role === 'user' ? 'U' : 'AI'}
            </div>
            <div className={styles.msgBubble}>
              <pre className={styles.msgContent}>{msg.content}</pre>
            </div>
          </div>
        ))}

        {/* Streaming message */}
        {streaming && (
          <div className={`${styles.msgRow} ${styles.msgAssistant}`}>
            <div className={styles.msgAvatar}>AI</div>
            <div className={styles.msgBubble}>
              <pre className={styles.msgContent}>
                {streamContent || <span className={styles.cursor}>|</span>}
                {streamContent && <span className={styles.cursor}>|</span>}
              </pre>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className={styles.inputArea}>
        <textarea
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={streaming}
        />
        {streaming ? (
          <button className={styles.stopBtn} onClick={handleStop}>Stop</button>
        ) : (
          <button className={styles.sendBtn} onClick={handleSend} disabled={!input.trim() || !selectedModel}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
