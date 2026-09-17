import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import { ToastProvider } from './contexts/ToastContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { AppConfigProvider } from './contexts/AppConfigContext';
import App from './App.tsx';
import EnvironmentBanner from './components/EnvironmentBanner';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <EnvironmentBanner />
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            {/* The price book and the plan feature map, for the landing page
                and the signup screen as well as the signed-in screens, so it
                sits above App rather than beside PlanProvider. */}
            <AppConfigProvider>
              <App />
            </AppConfigProvider>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>
);
