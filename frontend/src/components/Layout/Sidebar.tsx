import { useState, useCallback, useMemo, useEffect } from 'react';
import { marked } from 'marked';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { api } from '../../services/api';
import type { Role } from '../../types';
import styles from './Sidebar.module.css';

interface NavItem {
  path: string;
  label: string;
  end?: boolean;
  roles?: Role[];
}

interface NavGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  children: NavItem[];
  roles?: Role[];
}

type NavEntry = (NavItem & { icon: React.ReactNode }) | NavGroup;

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

/* Simple inline SVG icons */
const icons = {
  dashboard: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="7" height="7" rx="1" />
      <rect x="11" y="2" width="7" height="7" rx="1" />
      <rect x="2" y="11" width="7" height="7" rx="1" />
      <rect x="11" y="11" width="7" height="7" rx="1" />
    </svg>
  ),
  inference: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 17V8l4-5h6l4 5v9" />
      <path d="M3 12h14" />
      <path d="M7 12v5M13 12v5" />
      <circle cx="10" cy="6" r="1.5" />
    </svg>
  ),
  model: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="M3 7h14M7 7v10" />
    </svg>
  ),
  store: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 3h14v4H3z" />
      <path d="M5 7v10h10V7" />
      <path d="M8 10h4M10 10v4" />
    </svg>
  ),
  pool: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="10" cy="6" rx="7" ry="3" />
      <path d="M3 6v8c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M3 10c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="3" />
      <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
    </svg>
  ),
  chat: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4h14a1 1 0 011 1v8a1 1 0 01-1 1H7l-4 3v-3a1 1 0 01-1-1V5a1 1 0 011-1z" />
      <path d="M7 8h6M7 11h3" />
    </svg>
  ),
  docs: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 3h9l3 3v11H4z" />
      <path d="M13 3v3h3" />
      <path d="M7 9h6M7 12h4" />
    </svg>
  ),
  chevron: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 4l4 4-4 4" />
    </svg>
  ),
};

const NAV_ENTRIES: NavEntry[] = [
  { path: '/dashboard', label: '总览', icon: icons.dashboard },
  { path: '/chat', label: 'Chat', icon: icons.chat },
  {
    key: 'models',
    label: '模型管理',
    icon: icons.model,
    children: [
      { path: '/services', label: '模型服务' },
      { path: '/model-store', label: '模型商店' },
    ],
  },
  { path: '/api-docs', label: 'API 文档', icon: icons.docs },
  {
    key: 'system',
    label: '系统管理',
    icon: icons.settings,
    roles: ['admin'],
    children: [
      { path: '/users', label: '用户管理' },
      { path: '/api-keys', label: 'API 密钥' },
      { path: '/settings', label: '系统设置' },
      { path: '/system-logs', label: '系统日志' },
    ],
  },
];

export default function Sidebar() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelog, setChangelog] = useState('');
  const [buildTime, setBuildTime] = useState('');
  const changelogHtml = useMemo(() => changelog ? marked(changelog) as string : '', [changelog]);

  useEffect(() => {
    fetch('/api/v1/health').then(r => r.json()).then(d => {
      if (d.build_time) setBuildTime(d.build_time);
    }).catch(() => {});
  }, []);

  const handleShowChangelog = useCallback(async () => {
    setShowChangelog(true);
    if (!changelog) {
      try {
        const res = await api.get<{ content: string }>('/changelog');
        setChangelog(res.content);
      } catch {
        setChangelog('无法加载更新记录');
      }
    }
  }, [changelog]);

  // Determine which groups should be expanded based on current route
  const getInitialExpanded = () => {
    const expanded = new Set<string>();
    for (const entry of NAV_ENTRIES) {
      if (isGroup(entry)) {
        for (const child of entry.children) {
          if (location.pathname === child.path || location.pathname.startsWith(child.path + '/')) {
            expanded.add(entry.key);
            break;
          }
        }
      }
    }
    return expanded;
  };

  const [expanded, setExpanded] = useState<Set<string>>(getInitialExpanded);

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isVisible = (entry: { roles?: Role[] }) =>
    !entry.roles || (user && entry.roles.includes(user.role));

  const isGroupActive = (group: NavGroup) =>
    group.children.some(
      (child) => location.pathname === child.path || location.pathname.startsWith(child.path + '/'),
    );

  return (
    <nav className={styles.sidebar}>
      <div className={styles.logo}>LLM Platform</div>
      <ul className={styles.navList}>
        {NAV_ENTRIES.filter(isVisible).map((entry) => {
          if (isGroup(entry)) {
            const isOpen = expanded.has(entry.key);
            const groupActive = isGroupActive(entry);

            return (
              <li key={entry.key}>
                <button
                  className={`${styles.navGroupHeader} ${groupActive ? styles.navGroupHeaderActive : ''}`}
                  onClick={() => toggleGroup(entry.key)}
                >
                  <span className={styles.icon}>{entry.icon}</span>
                  <span className={styles.label}>{entry.label}</span>
                  <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
                    {icons.chevron}
                  </span>
                </button>
                <div className={`${styles.navGroupChildren} ${isOpen ? styles.navGroupChildrenOpen : ''}`}>
                  {entry.children.filter(isVisible).map((child) => (
                    <NavLink
                      key={child.path}
                      to={child.path}
                      end={child.end}
                      className={({ isActive }) =>
                        `${styles.navSubItem} ${isActive ? styles.active : ''}`
                      }
                    >
                      <span className={styles.label}>{child.label}</span>
                    </NavLink>
                  ))}
                </div>
              </li>
            );
          }

          return (
            <li key={entry.path}>
              <NavLink
                to={entry.path}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.active : ''}`
                }
              >
                <span className={styles.icon}>{entry.icon}</span>
                <span className={styles.label}>{entry.label}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>

      <div
        className={styles.version}
        onClick={handleShowChangelog}
        title="查看更新记录"
      >
        v{__APP_VERSION__}{buildTime ? ` (${buildTime})` : ''}
      </div>

      {showChangelog && (
        <div className={styles.changelogOverlay} onClick={() => setShowChangelog(false)}>
          <div className={styles.changelogModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.changelogHeader}>
              <span>更新记录</span>
              <button onClick={() => setShowChangelog(false)}>x</button>
            </div>
            <div
              className={styles.changelogContent}
              dangerouslySetInnerHTML={{ __html: changelogHtml || '<p>加载中...</p>' }}
            />
          </div>
        </div>
      )}
    </nav>
  );
}
