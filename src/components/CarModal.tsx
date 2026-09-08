import React, { useState, useEffect } from 'react';
import { X, Car as CarIcon, Save, ShieldCheck, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import type { CarWithDrivers } from '../types/car';

interface Driver {
  id: string;
  name: string;
}

interface CarModalProps {
  car: CarWithDrivers | null;
  onClose: () => void;
  onSuccess: () => void;
}

function defaultTuevDate(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

export default function CarModal({ car, onClose, onSuccess }: CarModalProps) {
  const [kennzeichen, setKennzeichen] = useState(car?.kennzeichen || '');
  const [tuevGueltigBis, setTuevGueltigBis] = useState(
    car?.tuev_gueltig_bis || defaultTuevDate()
  );
  const [letzteHu, setLetzteHu] = useState(car?.letzte_hu || '');
  const [selectedDriverIds, setSelectedDriverIds] = useState<string[]>(
    car?.drivers.map(d => d.id) || []
  );
  const [availableDrivers, setAvailableDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDrivers, setLoadingDrivers] = useState(true);
  const { user, companyId } = useAuth();
  const { showToast } = useToast();

  useEffect(() => { loadDrivers(); }, []);

  const loadDrivers = async () => {
    try {
      setLoadingDrivers(true);
      const { data, error } = await supabase
        .from('drivers')
        .select('id, name, status')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('name');
      if (error) throw error;
      setAvailableDrivers(data || []);
    } catch (error: any) {
      showToast('error', 'Fehler beim Laden der Fahrer: ' + error.message);
    } finally {
      setLoadingDrivers(false);
    }
  };

  const handleDriverToggle = (driverId: string) => {
    setSelectedDriverIds(prev => {
      if (prev.includes(driverId)) return prev.filter(id => id !== driverId);
      if (prev.length >= 2) {
        showToast('error', 'Maximal 2 Fahrer können einem Fahrzeug zugewiesen werden');
        return prev;
      }
      return [...prev, driverId];
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kennzeichen.trim()) { showToast('error', 'Bitte geben Sie ein Kennzeichen ein'); return; }
    if (!user) { showToast('error', 'Sie müssen angemeldet sein'); return; }

    try {
      setLoading(true);
      const carData = {
        kennzeichen:      kennzeichen.trim().toUpperCase(),
        tuev_gueltig_bis: tuevGueltigBis || null,
        letzte_hu:        letzteHu || null,
      };

      if (car) {
        const { error: updateError } = await supabase.from('cars').update(carData).eq('id', car.id);
        if (updateError) throw updateError;

        const { error: deleteError } = await supabase.from('car_driver_assignments').delete().eq('car_id', car.id);
        if (deleteError) throw deleteError;

        if (selectedDriverIds.length > 0) {
          const { error: insertError } = await supabase.from('car_driver_assignments').insert(
            selectedDriverIds.map(driverId => ({ car_id: car.id, driver_id: driverId, created_by: user.id, company_id: companyId }))
          );
          if (insertError) throw insertError;
        }
        showToast('success', 'Fahrzeug erfolgreich aktualisiert');
      } else {
        const { data: newCar, error: carError } = await supabase
          .from('cars').insert({ ...carData, created_by: user.id, company_id: companyId }).select().single();
        if (carError) throw carError;

        if (selectedDriverIds.length > 0 && newCar) {
          const { error: assignmentError } = await supabase.from('car_driver_assignments').insert(
            selectedDriverIds.map(driverId => ({ car_id: newCar.id, driver_id: driverId, created_by: user.id, company_id: companyId }))
          );
          if (assignmentError) throw assignmentError;
        }
        showToast('success', 'Fahrzeug erfolgreich erstellt');
      }
      onSuccess();
    } catch (error: any) {
      if (error.message.includes('duplicate key')) {
        showToast('error', 'Ein Fahrzeug mit diesem Kennzeichen existiert bereits');
      } else if (error.message.includes('maximum 2 drivers')) {
        showToast('error', 'Maximal 2 Fahrer können einem Fahrzeug zugewiesen werden');
      } else {
        showToast('error', 'Fehler beim Speichern: ' + error.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRenewTuev = () => {
    const base = tuevGueltigBis ? new Date(tuevGueltigBis) : new Date();
    base.setFullYear(base.getFullYear() + 1);
    setTuevGueltigBis(base.toISOString().split('T')[0]);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div
        className="rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)' }}
      >
        {/* Header */}
        <div
          className="sticky top-0 px-6 py-4 flex items-center justify-between z-10"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: 'var(--accent-subtle)' }}>
              <CarIcon className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />
            </div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {car ? 'Fahrzeug bearbeiten' : 'Neues Fahrzeug'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Kennzeichen */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Kennzeichen *
            </label>
            <input
              type="text"
              value={kennzeichen}
              onChange={(e) => setKennzeichen(e.target.value.toUpperCase())}
              className="input-base"
              placeholder="z.B. B-YA-1234"
              required
              disabled={loading}
            />
          </div>

          {/* TÜV / HU section */}
          <div
            className="rounded-xl p-4 space-y-4"
            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" style={{ color: 'var(--accent-text)' }} />
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                TÜV / Hauptuntersuchung
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  TÜV gültig bis
                </label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={tuevGueltigBis}
                    onChange={(e) => setTuevGueltigBis(e.target.value)}
                    className="input-base"
                    disabled={loading}
                  />
                  <button
                    type="button"
                    onClick={handleRenewTuev}
                    disabled={loading}
                    title="+1 Jahr ab aktuellem Datum"
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 whitespace-nowrap flex-shrink-0"
                    style={{
                      background: 'var(--accent-subtle)',
                      color: 'var(--accent-text)',
                      border: '1px solid var(--border)',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.opacity = '0.75')}
                    onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    +1 Jahr
                  </button>
                </div>
                <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Ablaufdatum der Hauptuntersuchung
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  Letzte HU
                </label>
                <input
                  type="date"
                  value={letzteHu}
                  onChange={(e) => setLetzteHu(e.target.value)}
                  className="input-base"
                  disabled={loading}
                />
                <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Datum der letzten Hauptuntersuchung
                </p>
              </div>
            </div>
          </div>

          {/* Drivers */}
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
              Fahrer zuweisen (max. 2)
            </label>
            {loadingDrivers ? (
              <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>Laden...</div>
            ) : availableDrivers.length === 0 ? (
              <div className="text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
                Keine Fahrer verfügbar. Bitte erstellen Sie zuerst Fahrer.
              </div>
            ) : (
              <div
                className="rounded-lg max-h-52 overflow-y-auto"
                style={{ border: '1px solid var(--border)' }}
              >
                {availableDrivers.map((driver) => {
                  const isSelected = selectedDriverIds.includes(driver.id);
                  const isDisabled = loading || (!isSelected && selectedDriverIds.length >= 2);
                  return (
                    <div
                      key={driver.id}
                      className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        background: isSelected
                          ? 'var(--accent-subtle)'
                          : 'transparent',
                        opacity: isDisabled && !isSelected ? 0.45 : 1,
                        cursor: isDisabled && !isSelected ? 'not-allowed' : 'pointer',
                      }}
                      onClick={() => !isDisabled && handleDriverToggle(driver.id)}
                      onMouseEnter={e => {
                        if (!isDisabled || isSelected)
                          (e.currentTarget as HTMLElement).style.background = isSelected
                            ? 'var(--accent-subtle)'
                            : 'var(--bg-subtle)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLElement).style.background = isSelected
                          ? 'var(--accent-subtle)'
                          : 'transparent';
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={e => { e.stopPropagation(); if (!isDisabled) handleDriverToggle(driver.id); }}
                        disabled={isDisabled}
                        className="w-4 h-4 cursor-pointer rounded"
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{driver.name}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {selectedDriverIds.length}/2 Fahrer ausgewählt
            </p>
          </div>

          {/* Footer buttons */}
          <div className="flex gap-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)', background: 'transparent' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}
            >
              <Save className="w-4 h-4" />
              {loading ? 'Speichern...' : 'Speichern'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
