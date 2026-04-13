import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Section name shown in the error UI */
  name?: string;
}

interface State {
  error: Error | null;
}

/**
 * Isolates render errors to a single section.
 * Other sections continue working even if this one crashes.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div style={{
          padding: 'var(--space-4)',
          borderRadius: 'var(--radius-md)',
          border: '1px dashed var(--color-border)',
          color: 'var(--color-text-tertiary)',
          fontSize: 'var(--font-size-sm)',
          textAlign: 'center',
        }}>
          {this.props.name ? `${this.props.name} 加载异常` : '此区域加载异常'}
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginLeft: 'var(--space-2)',
              color: 'var(--color-primary)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
