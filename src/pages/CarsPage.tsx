import CarsManagement from '../components/CarsManagement';
import { FleetImportShortcut } from '../components/partner/FleetImportShortcut';

// AppLayout already pads the page; the screen draws its own header (phase 5).
export default function CarsPage() {
  return (
    <>
      <FleetImportShortcut />
      <CarsManagement />
    </>
  );
}
