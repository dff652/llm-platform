import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import { Toast } from './components/common/Toast';

import AppLayout from './components/Layout/AppLayout';
import AuthGuard from './components/common/AuthGuard';
import GuestGuard from './components/common/GuestGuard';
import RoleRoute from './components/common/RoleRoute';

import Login from './pages/Login/Login';
import Dashboard from './pages/Dashboard/Dashboard';
import ServiceList from './pages/Services/ServiceList';
import ModelStore from './pages/ModelStore/ModelStore';
import UserManagement from './pages/UserManagement/UserManagement';
import ApiKeys from './pages/ApiKeys/ApiKeys';
import Chat from './pages/Chat/Chat';
import ApiCalls from './pages/ApiCalls/ApiCalls';
import ApiDocs from './pages/ApiDocs/ApiDocs';
import Settings from './pages/Settings/Settings';
import SystemLogs from './pages/Settings/SystemLogs';

function App() {
  const { initialized, initialize } = useAuthStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (!initialized) return null;

  return (
    <>
    <Toast />
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<GuestGuard><Login /></GuestGuard>} />

        {/* Protected — wrapped in AppLayout */}
        <Route element={<AuthGuard><AppLayout /></AuthGuard>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/services" element={<ServiceList />} />
          <Route path="/model-store" element={<ModelStore />} />
          <Route path="/api-calls" element={
            <RoleRoute roles={['admin']}>
              <ApiCalls />
            </RoleRoute>
          } />
          <Route path="/api-docs" element={<ApiDocs />} />
          <Route path="/users" element={
            <RoleRoute roles={['admin']}>
              <UserManagement />
            </RoleRoute>
          } />
          <Route path="/api-keys" element={
            <RoleRoute roles={['admin']}>
              <ApiKeys />
            </RoleRoute>
          } />
          <Route path="/settings" element={
            <RoleRoute roles={['admin']}>
              <Settings />
            </RoleRoute>
          } />
          <Route path="/system-logs" element={
            <RoleRoute roles={['admin']}>
              <SystemLogs />
            </RoleRoute>
          } />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </>
  );
}

export default App;
