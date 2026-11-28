import { useState } from 'react';
import CarsManagement from '../components/CarsManagement';
import { FleetUpdateButton, FleetUpdateOutcome } from '../components/partner/FleetUpdate';
import { useFleetUpdate } from '../components/partner/useFleetUpdate';

// AppLayout already pads the page; the screen draws its own header (phase 5).
export default function CarsPage() {
  // CarsManagement loads its own list; a new key makes it read again after an import.
  const [reload, setReload] = useState(0);
  // The update state lives here, above the key, so the outcome survives the reload it causes.
  const update = useFleetUpdate('vehicles', () => setReload(n => n + 1));
  return (
    <CarsManagement
      key={reload}
      headerActions={<FleetUpdateButton update={update} />}
      headerNotice={<FleetUpdateOutcome update={update} />}
    />
  );
}
