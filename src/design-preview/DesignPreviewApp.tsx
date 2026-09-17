import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DESIGN_PREVIEW_PATH } from './gate';
import PreviewLayout from './PreviewLayout';
import ComponentsPreview from './pages/ComponentsPreview';
import DashboardPreview from './pages/DashboardPreview';
import NotInPrototype from './pages/NotInPrototype';
import VehiclesPreview from './pages/VehiclesPreview';

/**
 * The Phase 2 prototype: the new shell, a calmer company dashboard and the
 * Fahrzeuge page, all on invented data. It reads and writes nothing.
 *
 * Built only when vite.config.ts enables __DESIGN_PREVIEW__ (dev server and
 * staging), and reachable only by typing /design-preview.
 */
export default function DesignPreviewApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path={DESIGN_PREVIEW_PATH} element={<PreviewLayout />}>
          <Route index element={<DashboardPreview />} />
          <Route path="fahrzeuge" element={<VehiclesPreview />} />
          <Route path="komponenten" element={<ComponentsPreview />} />
          <Route path="*" element={<NotInPrototype />} />
        </Route>
        <Route path="*" element={<Navigate to={DESIGN_PREVIEW_PATH} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
