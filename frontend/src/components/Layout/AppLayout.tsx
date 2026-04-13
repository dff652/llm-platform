import { Outlet } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import Sidebar from './Sidebar';
import DownloadIndicator from './DownloadIndicator';
import styles from './AppLayout.module.css';

export default function AppLayout() {
  const { user, logout } = useAuthStore();

  return (
    <div className={styles.layout}>
      <Sidebar />
      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarLeft} />
          <div className={styles.topbarRight}>
            <DownloadIndicator />
            <span className={styles.username}>
              {user?.displayName || user?.username}
            </span>
            <span className={styles.role}>{user?.role}</span>
            <button className={styles.logoutBtn} onClick={logout}>
              退出
            </button>
          </div>
        </header>
        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
