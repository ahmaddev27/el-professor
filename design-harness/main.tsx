import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from '../src/contexts/LanguageContext';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import { ToastProvider } from '../src/contexts/ToastContext';
import AppLayout from '../src/components/AppLayout';
import CarsPage from '../src/pages/CarsPage';
import FixkostenPage from '../src/pages/FixkostenPage';
import SalariesPage from '../src/pages/SalariesPage';
import BargeldbestandPage from '../src/pages/BargeldbestandPage';
import { AbrechnungPage } from '../src/pages/AbrechnungPage';
import '../src/index.css';
import { applyStoredPreferences, scenario } from './scenario';

/**
 * The production screen inside the production frame, as App.tsx mounts it for a
 * signed-in company user: AppLayout with its sidebar, top bar and banners, and
 * the page at its real route. Only the data and the session are invented (see
 * vite.config.ts); the router is in memory so the harness URL keeps its query.
 */

applyStoredPreferences();

const ROUTES = {
  fahrzeuge: '/cars',
  fixkosten: '/fixkosten',
  // Phase 5 batch 2.
  gehaelter: '/salaries',
  abrechnung: '/abrechnung',
  bargeld: '/bargeldbestand',
} as const;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[ROUTES[scenario.screen]]}>
            <Routes>
              <Route path="/" element={<AppLayout isSupportAdmin={false} />}>
                <Route path="cars" element={<CarsPage />} />
                <Route path="fixkosten" element={<FixkostenPage />} />
                <Route path="salaries" element={<SalariesPage />} />
                <Route path="abrechnung" element={<AbrechnungPage />} />
                <Route path="bargeldbestand" element={<BargeldbestandPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
);
