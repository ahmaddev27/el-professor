import React, { useState, useEffect } from 'react';
import { Plus, CreditCard as Edit2, Trash2, Car as CarIcon, Users, Download, ShieldCheck, ShieldAlert, ShieldX, Shield } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { usePlan } from '../contexts/PlanContext';
import CarModal from './CarModal';
import ConfirmationModal from './ConfirmationModal';
import type { CarWithDrivers, TuevStatus } from '../types/car';
import { getTuevStatus } from '../types/car';
import { exportTableToExcel } from '../utils/excelExport';

type TuevFilter = 'all' | TuevStatus;

const TUEV_CONFIG: Record<TuevStatus, {
  label: string;
  shortLabel: string;
  bg: string;
  border: string;
  color: string;
  icon: React.ReactNode;
}> = {
  gueltig: {
    label: 'Gültig',
    shortLabel: 'Gültig',
    bg: 'var(--success-subtle)',
    border: 'rgba(5,150,105,0.3)',
    color: 'var(--success)',
    icon: <ShieldCheck className="w-3.5 h-3.5" />,
  },
  bald_ablaufend: {
    label: 'Läuft bald ab',
    shortLabel: 'Bald ablaufend',
    bg: 'var(--warning-subtle)',
    border: 'rgba(217,119,6,0.3)',
    color: 'var(--warning)',
    icon: <ShieldAlert className="w-3.5 h-3.5" />,
  },
  abgelaufen: {
    label: 'Abgelaufen',
    shortLabel: 'Abgelaufen',
    bg: 'var(--danger-subtle)',
    border: 'rgba(220,38,38,0.3)',
    color: 'var(--danger)',
    icon: <ShieldX className="w-3.5 h-3.5" />,
  },
  unbekannt: {
    label: 'Nicht hinterlegt',
    shortLabel: 'Unbekannt',
    bg: 'var(--bg-subtle)',
    border: 'var(--border)',
    color: 'var(--text-tertiary)',
    icon: <Shield className="w-3.5 h-3.5" />,
  },
};

export default function CarsManagement() {
  const [cars, setCars] = useState<CarWithDrivers[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCar, setEditingCar] = useState<CarWithDrivers | null>(null);
  const [tuevFilter, setTuevFilter] = useState<TuevFilter>('all');
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ isOpen: boolean; carId: string | null; kennzeichen: string }>({
    isOpen: false,
    carId: null,
    kennzeichen: '',
  });

  const { user, companyId } = useAuth();
  const { showToast } = useToast();
  const { planState } = usePlan();

  useEffect(() => {
    loadCars();
  }, []);

  const loadCars = async () => {
    try {
      setLoading(true);

      const { data: carsData, error: carsError } = await supabase
        .from('cars')
        .select('*')
        .eq('company_id', companyId)
        .order('kennzeichen');

      if (carsError) throw carsError;

      const { data: assignmentsData, error: assignmentsError } = await supabase
        .from('car_driver_assignments')
        .select(`car_id, driver_id, drivers (id, name)`)
        .eq('company_id', companyId);

      if (assignmentsError) throw assignmentsError;

      const { data: driversData, error: driversError } = await supabase
        .from('drivers')
        .select('id, name')
        .eq('company_id', companyId);

      if (driversError) throw driversError;

      const driverMap = new Map(driversData?.map(d => [d.id, d]) || []);

      const carsWithDrivers: CarWithDrivers[] = (carsData || []).map(car => {
        const carAssignments = (assignmentsData || []).filter(a => a.car_id === car.id);
        const drivers = carAssignments
          .map(a => {
            const driver = driverMap.get(a.driver_id);
            return driver ? { id: driver.id, name: driver.name } : null;
          })
          .filter((d): d is { id: string; name: string } => d !== null);

        return { ...car, drivers };
      });

      setCars(carsWithDrivers);
    } catch (error: any) {
      console.error('Error loading cars:', error);
      showToast('error', 'Fehler beim Laden der Fahrzeuge: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const activeCars = cars.filter(c => (c as any).status !== 'inactive');
  const carLimit = planState.carLimit;
  const carLimitReached = activeCars.length >= carLimit;

  const handleAddCar = () => {
    if (carLimitReached) {
      showToast('error', `Fahrzeuglimit erreicht. Ihr Abonnement erlaubt maximal ${carLimit} aktive Fahrzeuge.`);
      return;
    }
    setEditingCar(null);
    setIsModalOpen(true);
  };
  const handleEditCar   = (car: CarWithDrivers) => { setEditingCar(car); setIsModalOpen(true); };
  const handleModalClose   = () => { setIsModalOpen(false); setEditingCar(null); };
  const handleModalSuccess = () => { loadCars(); handleModalClose(); };

  const handleDeleteCar = (car: CarWithDrivers) => {
    setDeleteConfirmation({ isOpen: true, carId: car.id, kennzeichen: car.kennzeichen });
  };

  const confirmDelete = async () => {
    if (!deleteConfirmation.carId) return;
    try {
      const { error } = await supabase.from('cars').delete().eq('id', deleteConfirmation.carId);
      if (error) throw error;
      showToast('success', 'Fahrzeug erfolgreich gelöscht');
      loadCars();
    } catch (error: any) {
      console.error('Error deleting car:', error);
      showToast('error', 'Fehler beim Löschen des Fahrzeugs: ' + error.message);
    } finally {
      setDeleteConfirmation({ isOpen: false, carId: null, kennzeichen: '' });
    }
  };

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filteredCars = tuevFilter === 'all'
    ? cars
    : cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === tuevFilter);

  // ── Summary counts ────────────────────────────────────────────────────────
  const counts = {
    abgelaufen:    cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'abgelaufen').length,
    bald_ablaufend: cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'bald_ablaufend').length,
    gueltig:       cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'gueltig').length,
    unbekannt:     cars.filter(c => getTuevStatus(c.tuev_gueltig_bis).status === 'unbekannt').length,
  };

  const handleExport = () => {
    exportTableToExcel({
      filename: `fahrzeuge_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: 'Fahrzeugliste',
      moduleName: 'Fahrzeuge',
      filterSummary: tuevFilter !== 'all' ? [`TÜV-Status: ${TUEV_CONFIG[tuevFilter as TuevStatus].label}`] : [],
      columns: [
        { key: 'kennzeichen',      label: 'Kennzeichen',        width: 18 },
        { key: 'drivers',          label: 'Zugeordnete Fahrer', width: 36, format: v => (v as { name: string }[] ?? []).map(d => d.name).join(', ') || '—' },
        { key: 'tuev_gueltig_bis', label: 'TÜV gültig bis',    width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '—' },
        { key: 'tuev_status',      label: 'TÜV-Status',        width: 18 },
        { key: 'letzte_hu',        label: 'Letzte HU',         width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '—' },
        { key: 'created_at',       label: 'Erstellt am',       width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: filteredCars.map(c => {
        const { status, daysLeft } = getTuevStatus(c.tuev_gueltig_bis);
        const cfg = TUEV_CONFIG[status];
        const statusLabel = daysLeft !== null && daysLeft >= 0
          ? `${cfg.label} (noch ${daysLeft} Tage)`
          : daysLeft !== null
          ? `${cfg.label} (vor ${Math.abs(daysLeft)} Tagen)`
          : cfg.label;
        return { ...(c as unknown as Record<string, unknown>), tuev_status: statusLabel };
      }),
      totals: { kennzeichen: `${filteredCars.length} Fahrzeuge` },
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div style={{ color: 'var(--text-tertiary)' }}>Laden...</div>
      </div>
    );
  }

  const filterButtons: { key: TuevFilter; label: string; count?: number }[] = [
    { key: 'all', label: `Alle (${cars.length})` },
    { key: 'abgelaufen',    label: `Abgelaufen`,     count: counts.abgelaufen },
    { key: 'bald_ablaufend', label: `Bald ablaufend`, count: counts.bald_ablaufend },
    { key: 'gueltig',       label: `Gültig`,         count: counts.gueltig },
    { key: 'unbekannt',     label: `Unbekannt`,      count: counts.unbekannt },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-start flex-wrap gap-3">
        <div>
          <h2 style={{ color: 'var(--text-primary)' }} className="text-2xl font-bold">Fahrzeuge</h2>
          <p style={{ color: 'var(--text-secondary)' }} className="mt-1">
            Fahrzeuge, Fahrerzuordnungen und TÜV-Status
            <span className="ml-2 text-xs font-medium" style={{ color: carLimitReached ? 'var(--danger)' : 'var(--text-tertiary)' }}>
              ({activeCars.length}/{carLimit} Aktive Fahrzeuge)
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
            style={{ background: 'var(--success)', color: 'white' }}
            title="Als Excel exportieren"
          >
            <Download className="w-4 h-4" />
            Excel
          </button>
          <button
            onClick={handleAddCar}
            disabled={carLimitReached}
            style={{
              background: carLimitReached ? 'var(--bg-muted)' : 'var(--accent)',
              color: carLimitReached ? 'var(--text-tertiary)' : 'var(--accent-text)',
              borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none',
              cursor: carLimitReached ? 'not-allowed' : 'pointer',
            }}
            className="flex items-center gap-2"
            title={carLimitReached ? `Fahrzeuglimit erreicht (${carLimit} Fahrzeuge)` : 'Neues Fahrzeug hinzufügen'}
          >
            <Plus className="w-5 h-5" />
            Neues Fahrzeug
          </button>
        </div>
      </div>

      {/* Limit banner */}
      {carLimitReached && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl" style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(220,38,38,0.25)' }}>
          <CarIcon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            <strong>Fahrzeuglimit erreicht.</strong> Ihr Abonnement erlaubt maximal <strong>{carLimit}</strong> aktive Fahrzeuge. Kontaktieren Sie uns um Ihr Limit zu erhöhen.
          </p>
        </div>
      )}

      {/* TÜV summary banner — only shown when there are cars with issues */}
      {cars.length > 0 && (counts.abgelaufen > 0 || counts.bald_ablaufend > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {counts.abgelaufen > 0 && (
            <div
              className="flex items-center gap-3 p-4 rounded-xl"
              style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(220,38,38,0.25)' }}
            >
              <ShieldX className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>
                  {counts.abgelaufen} Fahrzeug{counts.abgelaufen > 1 ? 'e' : ''} — TÜV abgelaufen
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>TÜV-Termin überfällig, sofort erneuern</p>
              </div>
            </div>
          )}
          {counts.bald_ablaufend > 0 && (
            <div
              className="flex items-center gap-3 p-4 rounded-xl"
              style={{ background: 'var(--warning-subtle)', border: '1px solid rgba(217,119,6,0.25)' }}
            >
              <ShieldAlert className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--warning)' }}>
                  {counts.bald_ablaufend} Fahrzeug{counts.bald_ablaufend > 1 ? 'e' : ''} — TÜV läuft bald ab
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>Innerhalb von 60 Tagen fällig</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TÜV filter buttons */}
      {cars.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {filterButtons.map(btn => {
            const isActive = tuevFilter === btn.key;
            const cfg = btn.key !== 'all' ? TUEV_CONFIG[btn.key as TuevStatus] : null;
            return (
              <button
                key={btn.key}
                onClick={() => setTuevFilter(btn.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: isActive
                    ? (cfg?.bg ?? 'var(--bg-elevated)')
                    : 'var(--bg-surface)',
                  color: isActive
                    ? (cfg?.color ?? 'var(--text-primary)')
                    : 'var(--text-secondary)',
                  border: isActive
                    ? `1px solid ${cfg?.border ?? 'var(--border)'}`
                    : '1px solid var(--border)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {cfg?.icon}
                {btn.key !== 'all' ? `${btn.label} (${btn.count})` : btn.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Cars grid */}
      {filteredCars.length === 0 ? (
        <div
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '0.5rem', boxShadow: 'var(--shadow-sm)' }}
          className="p-8 text-center"
        >
          <CarIcon style={{ color: 'var(--text-tertiary)' }} className="w-16 h-16 mx-auto mb-4" />
          <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-medium mb-2">
            {cars.length === 0 ? 'Keine Fahrzeuge vorhanden' : 'Keine Fahrzeuge für diesen Filter'}
          </h3>
          <p style={{ color: 'var(--text-secondary)' }} className="mb-4">
            {cars.length === 0 ? 'Erstellen Sie Ihr erstes Fahrzeug, um zu beginnen.' : 'Probieren Sie einen anderen TÜV-Status-Filter.'}
          </p>
          {cars.length === 0 && (
            <button
              onClick={handleAddCar}
              style={{ background: 'var(--accent)', color: 'var(--accent-text)', borderRadius: '0.5rem', padding: '0.5rem 1rem', border: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
              className="inline-flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Fahrzeug hinzufügen
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredCars.map((car) => {
            const { status, daysLeft } = getTuevStatus(car.tuev_gueltig_bis);
            const tuevCfg = TUEV_CONFIG[status];

            return (
              <div
                key={car.id}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '0.75rem',
                  boxShadow: 'var(--shadow-sm)',
                }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--shadow-md)')}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = 'var(--shadow-sm)')}
                className="p-5 flex flex-col gap-4"
              >
                {/* Card header */}
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div style={{ background: 'var(--accent-subtle)', borderRadius: '0.5rem', padding: '0.6rem' }}>
                      <CarIcon style={{ color: 'var(--accent)' }} className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 style={{ color: 'var(--text-primary)' }} className="text-lg font-bold tracking-wide">{car.kennzeichen}</h3>
                      <p style={{ color: 'var(--text-tertiary)' }} className="text-xs">Kennzeichen</p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleEditCar(car)}
                      style={{ color: 'var(--accent)', borderRadius: '0.5rem', padding: '0.4rem' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      title="Bearbeiten"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteCar(car)}
                      style={{ color: 'var(--danger)', borderRadius: '0.5rem', padding: '0.4rem' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--danger-subtle)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      title="Löschen"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* TÜV badge */}
                <div
                  className="rounded-xl px-3 py-2.5 flex items-center justify-between gap-2"
                  style={{ background: tuevCfg.bg, border: `1px solid ${tuevCfg.border}` }}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ color: tuevCfg.color }}>{tuevCfg.icon}</span>
                    <div>
                      <p className="text-xs font-semibold leading-tight" style={{ color: tuevCfg.color }}>TÜV {tuevCfg.label}</p>
                      {car.tuev_gueltig_bis && (
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                          {new Date(car.tuev_gueltig_bis).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                        </p>
                      )}
                    </div>
                  </div>
                  {daysLeft !== null && (
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
                      style={{ background: tuevCfg.color + '18', color: tuevCfg.color }}
                    >
                      {daysLeft >= 0 ? `${daysLeft}T` : `−${Math.abs(daysLeft)}T`}
                    </span>
                  )}
                </div>

                {/* Letzte HU (if present) */}
                {car.letzte_hu && (
                  <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>Letzte HU: {new Date(car.letzte_hu).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>
                  </div>
                )}

                {/* Drivers */}
                <div style={{ borderTop: '1px solid var(--border)' }} className="pt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Users style={{ color: 'var(--text-tertiary)' }} className="w-3.5 h-3.5" />
                    <span style={{ color: 'var(--text-secondary)' }} className="text-xs font-medium">
                      Fahrer ({car.drivers.length}/2)
                    </span>
                  </div>
                  {car.drivers.length > 0 ? (
                    <div className="space-y-1.5">
                      {car.drivers.map((driver) => (
                        <div
                          key={driver.id}
                          style={{ background: 'var(--bg-subtle)', borderRadius: '0.4rem', padding: '0.35rem 0.6rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}
                        >
                          {driver.name}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ color: 'var(--text-tertiary)' }} className="text-xs italic">Keine Fahrer zugewiesen</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isModalOpen && (
        <CarModal car={editingCar} onClose={handleModalClose} onSuccess={handleModalSuccess} />
      )}

      {deleteConfirmation.isOpen && (
        <ConfirmationModal
          isOpen={deleteConfirmation.isOpen}
          type="confirm"
          title="Fahrzeug löschen"
          message={`Möchten Sie das Fahrzeug "${deleteConfirmation.kennzeichen}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`}
          confirmText="Löschen"
          cancelText="Abbrechen"
          onConfirm={confirmDelete}
          onClose={() => setDeleteConfirmation({ isOpen: false, carId: null, kennzeichen: '' })}
        />
      )}
    </div>
  );
}
