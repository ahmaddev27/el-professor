export interface Car {
  id: string;
  kennzeichen: string;
  tuev_gueltig_bis: string | null;
  letzte_hu: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CarDriverAssignment {
  id: string;
  car_id: string;
  driver_id: string;
  assigned_at: string;
  created_by: string;
}

export interface CarWithDrivers extends Car {
  drivers: Array<{
    id: string;
    name: string;
    /**
     * `drivers.status`. A deactivated driver keeps an assignment they already
     * hold — hiding the row would make the vehicle read as unassigned, which is
     * the one state the operator has to see in order to fix it — so the name is
     * marked instead. Carried here because the read used to ask for
     * `id, name` only and so could not tell.
     */
    status?: string | null;
  }>;
}

export type TuevStatus = 'gueltig' | 'bald_ablaufend' | 'abgelaufen' | 'unbekannt';

export interface TuevInfo {
  status: TuevStatus;
  daysLeft: number | null;
}

/** Returns TÜV status based on expiry date. Threshold: 60 days = warning. */
export function getTuevStatus(tuevGueltigBis: string | null): TuevInfo {
  if (!tuevGueltigBis) return { status: 'unbekannt', daysLeft: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(tuevGueltigBis);
  expiry.setHours(0, 0, 0, 0);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.round((expiry.getTime() - today.getTime()) / msPerDay);
  if (daysLeft < 0)  return { status: 'abgelaufen',    daysLeft };
  if (daysLeft <= 60) return { status: 'bald_ablaufend', daysLeft };
  return { status: 'gueltig', daysLeft };
}
