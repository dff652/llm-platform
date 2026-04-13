import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { Badge } from '../../components/common/Badge';
import type { ModelEntity } from '../../types';
import styles from './ModelCenter.module.css';

export default function ModelCenter() {
  const [models, setModels] = useState<ModelEntity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<ModelEntity[]>('/models')
      .then(setModels)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className={styles.page}><p>Loading...</p></div>;

  return (
    <div className={styles.page}>
      <h2>Model Registry</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Family</th>
            <th>Runtime</th>
            <th>Version</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td><strong>{m.name}</strong></td>
              <td>{m.family}</td>
              <td>{m.runtimeType}</td>
              <td>{m.version || '-'}</td>
              <td><Badge variant={m.status === 'active' ? 'success' : 'default'}>{m.status}</Badge></td>
            </tr>
          ))}
          {models.length === 0 && (
            <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--color-text-secondary)', padding: '2rem' }}>
              No models registered. Use Model Store to download and publish models.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
