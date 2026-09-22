import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from '../src/contexts/LanguageContext';
import { ThemeProvider } from '../src/contexts/ThemeContext';
import { ToastProvider } from '../src/contexts/ToastContext';
import AppLayout from '../src/components/AppLayout';
import BelegePage from '../src/pages/BelegePage';
import CarsPage from '../src/pages/CarsPage';
import FahrerPage from '../src/pages/FahrerPage';
import FixkostenPage from '../src/pages/FixkostenPage';
import SalariesPage from '../src/pages/SalariesPage';
import BargeldbestandPage from '../src/pages/BargeldbestandPage';
import { AbrechnungPage } from '../src/pages/AbrechnungPage';
import UmsaetzePage from '../src/pages/UmsaetzePage';
import '../src/index.css';
import { BATCH3_ROUTES, batch3InitialEntry } from './batch3/routes';
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
  // Phase 5 batch 1b.
  belege: '/belege',
  fahrer: '/fahrer',
  umsaetze: '/umsaetze',
} as const;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[batch3InitialEntry() ?? ROUTES[scenario.screen]]}>
            <Routes>
              <Route path="/" element={<AppLayout isSupportAdmin={false} />}>
                <Route path="cars" element={<CarsPage />} />
                <Route path="fixkosten" element={<FixkostenPage />} />
                <Route path="salaries" element={<SalariesPage />} />
                <Route path="abrechnung" element={<AbrechnungPage />} />
                <Route path="bargeldbestand" element={<BargeldbestandPage />} />
                {/* Phase 5 batch 1b: Belege, Fahrer, Umsätze. */}
                <Route path="belege" element={<BelegePage />} />
                <Route path="fahrer" element={<FahrerPage />} />
                <Route path="umsaetze" element={<UmsaetzePage />} />
                {/* Phase 5 batch 3: Dokumente, Stundennachweis, Monatsplanung. */}
                {BATCH3_ROUTES}
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
);
