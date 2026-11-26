import { useState } from 'react';
import CarsManagement from '../components/CarsManagement';
import { FleetImportShortcut } from '../components/partner/FleetImportShortcut';

// AppLayout already pads the page; the screen draws its own header (phase 5).
export default function CarsPage() {
  // CarsManagement loads its own list; a new key makes it read again after an import.
  const [reload, setReload] = useState(0);
  return (
    <>
      <FleetImportShortcut scope="vehicles" onImported={() => setReload(n => n + 1)} />
      <CarsManagement key={reload} />
    </>
  );
}
