import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import type { Role } from '../../types';

interface RoleRouteProps {
  roles: Role[];
  children: React.ReactNode;
}

export default function RoleRoute({ roles, children }: RoleRouteProps) {
  const user = useAuthStore((s) => s.user);

  if (!user || !roles.includes(user.role)) {
    return <Navigate to="/inference" replace />;
  }

  return <>{children}</>;
}
