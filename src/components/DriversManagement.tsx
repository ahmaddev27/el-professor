import React, { useState } from 'react';
import { Plus, CreditCard as Edit, Trash2, User, Users, Power, PowerOff, Download, AlertTriangle } from 'lucide-react';
import { Driver } from '../types/receipt';
import DriverModal, { DriverPlanningFields } from './DriverModal';
import { exportTableToExcel } from '../utils/excelExport';
import { usePlan } from '../contexts/PlanContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';

interface DriversManagementProps {
  drivers: Driver[];
  onAddDriver: (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning?: DriverPlanningFields) => void;
  onEditDriver: (id: string, name: string, salaryRatio: number, status?: 'active' | 'inactive', personalnummer?: string, gender?: 'male' | 'female' | null, planning?: DriverPlanningFields) => void;
  onDeleteDriver: (id: string) => void;
  canEdit: (driver: Driver) => boolean;
  canDelete: (driver: Driver) => boolean;
}

const DriversManagement: React.FC<DriversManagementProps> = ({
  drivers,
  onAddDriver,
  onEditDriver,
  onDeleteDriver,
  canEdit,
  canDelete
}) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDriver, setEditingDriver] = useState<Driver | undefined>();
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const activeDrivers = drivers.filter(d => d.status === 'active');
  const inactiveDrivers = drivers.filter(d => d.status === 'inactive');

  const { planState } = usePlan();
  const { settings: companySettings } = useCompanySettings();
  const driversPerCar = companySettings?.drivers_per_car_limit ?? 4;
  const driverLimit = planState.carLimit * driversPerCar;
  const driverLimitReached = activeDrivers.length >= driverLimit;

  const handleSave = (name: string, salaryRatio: number, personalnummer: string, gender: 'male' | 'female' | null, planning: DriverPlanningFields) => {
    if (editingDriver) {
      onEditDriver(editingDriver.id, name, salaryRatio, undefined, personalnummer, gender, planning);
    } else {
      onAddDriver(name, salaryRatio, personalnummer, gender, planning);
    }
    setIsModalOpen(false);
    setEditingDriver(undefined);
  };

  const handleEdit = (driver: Driver) => {
    setEditingDriver(driver);
    setIsModalOpen(true);
  };

  const handleDelete = (id: string) => {
    onDeleteDriver(id);
  };

  const handleToggleStatus = (driver: Driver) => {
    const newStatus = driver.status === 'active' ? 'inactive' : 'active';
    onEditDriver(driver.id, driver.name, driver.salaryRatio || 0, newStatus);
  };

  const handleExport = () => {
    const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
    exportTableToExcel({
      filename: `fahrer_${new Date().toISOString().split('T')[0]}`,
      sheetTitle: 'Fahrerliste',
      moduleName: 'Fahrer',
      columns: [
        { key: 'name',                          label: 'Fahrername',            width: 28 },
        { key: 'personalnummer',                label: 'Personalnr.',           width: 16 },
        { key: 'status',                        label: 'Status',                width: 12, format: v => v === 'active' ? 'Aktiv' : 'Inaktiv' },
        { key: 'gender',                        label: 'Anrede',                width: 10, format: v => v === 'male' ? 'Herr' : v === 'female' ? 'Frau' : '' },
        { key: 'employment_type',               label: 'Anstellungsart',        width: 22, format: v => v === 'company_owner' ? 'Inhaber / Selbstständig' : v === 'employee' ? 'Angestellt' : '' },
        { key: 'salaryRatio',                   label: 'Gehaltsanteil',         width: 16, align: 'right' as const, format: v => v != null ? `${((v as number) * 100).toFixed(0)} %` : '' },
        { key: 'planning_enabled',              label: 'Planung aktiv',         width: 14, format: v => v === true ? 'Ja' : v === false ? 'Nein' : '' },
        { key: 'planning_hourly_rate',          label: 'Stundensatz (€)',       width: 16, align: 'right' as const, format: v => v != null ? `${(v as number).toFixed(2)} €` : '' },
        { key: 'planning_min_salary',           label: 'Mindestgehalt (€)',     width: 16, align: 'right' as const, format: v => v != null ? `${(v as number).toFixed(2)} €` : '' },
        { key: 'planning_max_salary',           label: 'Maximalgehalt (€)',     width: 16, align: 'right' as const, format: v => v != null ? `${(v as number).toFixed(2)} €` : '' },
        { key: 'target_monthly_hours',          label: 'Ziel-Std./Monat',      width: 16, align: 'right' as const, format: v => v != null ? String(v) : '' },
        { key: 'max_monthly_hours',             label: 'Max-Std./Monat',       width: 16, align: 'right' as const, format: v => v != null ? String(v) : '' },
        { key: 'driver_usage_type',             label: 'Einsatztyp',            width: 20, format: v => v === 'regular' ? 'Regulär' : v === 'coverage_only' ? 'Nur Vertretung' : '' },
        { key: 'can_cover_other_drivers',       label: 'Kann vertreten',        width: 14, format: v => v === true ? 'Ja' : v === false ? 'Nein' : '' },
        { key: 'planning_priority',             label: 'Priorität',             width: 12, align: 'right' as const, format: v => v != null ? String(v) : '' },
        { key: 'allowed_weekdays',              label: 'Erlaubte Wochentage',   width: 28, format: v => Array.isArray(v) ? (v as number[]).map(n => WEEKDAYS[n] ?? n).join(', ') : v == null ? 'Alle' : '' },
        { key: 'work_window_start',             label: 'Arbeitsfenster Von',    width: 18, format: v => v != null ? String(v) : '' },
        { key: 'work_window_end',               label: 'Arbeitsfenster Bis',    width: 18, format: v => v != null ? String(v) : '' },
        { key: 'is_full_day_available',         label: 'Ganztägig verfügbar',   width: 18, format: v => v === true ? 'Ja' : v === false ? 'Nein' : '' },
        { key: 'allow_outside_shift_exceptions',label: 'Ausnahmen erlaubt',     width: 18, format: v => v === true ? 'Ja' : v === false ? 'Nein' : '' },
        { key: 'createdBy',                     label: 'Erstellt von',          width: 28 },
        { key: 'createdAt',                     label: 'Erstellt am',           width: 16, format: v => v ? new Date(v as string).toLocaleDateString('de-DE') : '' },
      ],
      rows: drivers as unknown as Record<string, unknown>[],
      totals: {
        name: `${drivers.length} Fahrer gesamt (${activeDrivers.length} aktiv, ${inactiveDrivers.length} inaktiv)`,
      },
    });
  };

  return (
    <div className="space-y-8">
      {/* Enhanced Header Section */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-800 rounded-xl shadow-lg p-6 text-white">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center space-y-4 sm:space-y-0">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="bg-white bg-opacity-20 rounded-lg p-2">
                <Users className="text-white" size={32} />
              </div>
              <div>
                <h1 className="text-3xl font-bold">Fahrerverwaltung</h1>
                <p className="text-blue-100 mt-1">Verwalten Sie Ihre Fahrer effizient ({activeDrivers.length}/{driverLimit} Aktive Fahrer)</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleExport}
              className="px-4 py-3 bg-white bg-opacity-20 hover:bg-opacity-30 text-white rounded-lg transition-all duration-200 flex items-center space-x-2 font-medium"
              title="Als Excel exportieren"
            >
              <Download size={16} />
              <span>Excel</span>
            </button>
            <button
              onClick={() => !driverLimitReached && setIsModalOpen(true)}
              disabled={driverLimitReached}
              className={`px-6 py-3 rounded-lg transition-all duration-200 flex items-center space-x-2 shadow-md font-semibold ${
                driverLimitReached
                  ? 'bg-white bg-opacity-30 text-white text-opacity-60 cursor-not-allowed'
                  : 'bg-white text-blue-600 hover:bg-blue-50 hover:shadow-lg transform hover:-translate-y-0.5'
              }`}
              title={driverLimitReached ? `Limit erreicht: max. ${driverLimit} aktive Fahrer` : 'Neuer Fahrer'}
            >
              <Plus size={18} />
              <span>Neuer Fahrer</span>
            </button>
          </div>
        </div>
      </div>

      {/* Driver Limit Banner */}
      {driverLimitReached && (
        <div className="flex items-center gap-3 px-5 py-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-800">
          <AlertTriangle size={20} className="flex-shrink-0 text-amber-500" />
          <p className="text-sm font-medium">
            Fahrerlimit erreicht. Ihr Abonnement erlaubt maximal {driverLimit} aktive Fahrer ({planState.carLimit} Fahrzeuge &times; {driversPerCar}).
          </p>
        </div>
      )}

      {/* Statistics Card */}
      <div
        className="rounded-xl p-6"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-md)', border: '1px solid var(--border)' }}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="text-center">
            <div
              className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center"
              style={{ background: 'var(--success-subtle)' }}
            >
              <Power style={{ color: 'var(--success)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{activeDrivers.length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Aktive Fahrer</p>
          </div>
          <div className="text-center">
            <div
              className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center"
              style={{ background: 'var(--danger-subtle)' }}
            >
              <PowerOff style={{ color: 'var(--danger)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{inactiveDrivers.length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Inaktive Fahrer</p>
          </div>
          <div className="text-center">
            <div
              className="rounded-full p-4 w-16 h-16 mx-auto mb-3 flex items-center justify-center"
              style={{ background: 'var(--accent-subtle)' }}
            >
              <Users style={{ color: 'var(--accent-text)' }} size={24} />
            </div>
            <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{drivers.length}</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Gesamt</p>
          </div>
        </div>
      </div>

      {/* Drivers List */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)' }}
      >
        {drivers.length === 0 ? (
          <div className="text-center py-16">
            <div
              className="rounded-full p-6 w-24 h-24 mx-auto mb-4 flex items-center justify-center"
              style={{ background: 'var(--bg-subtle)' }}
            >
              <Users className="h-12 w-12" style={{ color: 'var(--text-tertiary)' }} />
            </div>
            <h3 className="text-xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Keine Fahrer vorhanden</h3>
            <p className="mb-6 max-w-md mx-auto" style={{ color: 'var(--text-secondary)' }}>
              Fügen Sie Ihren ersten Fahrer hinzu, um zu beginnen.
            </p>
            <div>
              <button
                onClick={() => !driverLimitReached && setIsModalOpen(true)}
                disabled={driverLimitReached}
                className="inline-flex items-center px-6 py-3 shadow-sm text-sm font-semibold rounded-lg text-white transition-all duration-200 hover:shadow-lg transform hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: 'var(--accent)' }}
              >
                <Plus className="mr-2 h-5 w-5" />
                Neuer Fahrer
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block">
              <table className="w-full">
                <thead style={{ background: 'var(--bg-subtle)' }}>
                  <tr>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      #
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      Fahrername
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      Status
                    </th>
                    <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      Erstellt von
                    </th>
                    <th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                      Aktionen
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {drivers.map((driver, index) => (
                    <tr
                      key={driver.id}
                      style={{
                        background: hoveredRow === driver.id ? 'var(--bg-subtle)' : 'transparent',
                        borderBottom: '1px solid var(--border)',
                        opacity: driver.status === 'inactive' ? 0.6 : 1,
                        transition: 'background 0.2s'
                      }}
                      onMouseEnter={() => setHoveredRow(driver.id)}
                      onMouseLeave={() => setHoveredRow(null)}
                    >
                      <td className="px-6 py-5 whitespace-nowrap text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {index + 1}
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-10 w-10">
                            <div className={`h-10 w-10 rounded-full ${driver.status === 'active' ? 'bg-gradient-to-br from-blue-400 to-blue-600' : 'bg-gradient-to-br from-gray-400 to-gray-600'} flex items-center justify-center shadow-md`}>
                              <User className="h-5 w-5 text-white" />
                            </div>
                          </div>
                          <div className="ml-4">
                            <div className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                              {driver.name}
                              {driver.employment_type === 'company_owner' && (
                                <span
                                  className="px-2 py-0.5 text-xs font-semibold rounded-full"
                                  style={{ background: 'rgba(16,185,129,0.12)', color: '#047857' }}
                                >
                                  Inhaber / Selbstständig
                                </span>
                              )}
                            </div>
                            <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                              {driver.personalnummer ? `Pers.-Nr.: ${driver.personalnummer}` : 'Keine Personalnummer'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        <span
                          className="px-3 py-1 inline-flex text-xs leading-5 font-semibold rounded-full"
                          style={
                            driver.status === 'active'
                              ? { background: 'var(--success-subtle)', color: 'var(--success)' }
                              : { background: 'var(--danger-subtle)', color: 'var(--danger)' }
                          }
                        >
                          {driver.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                        </span>
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap">
                        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                          {driver.createdBy || 'Unbekannt'}
                        </div>
                      </td>
                      <td className="px-6 py-5 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex justify-end space-x-2">
                          <button
                            onClick={() => canEdit(driver) && handleToggleStatus(driver)}
                            disabled={!canEdit(driver)}
                            className="p-2 rounded-lg transition-all duration-200"
                            style={
                              canEdit(driver)
                                ? { color: driver.status === 'active' ? 'var(--warning)' : 'var(--success)', cursor: 'pointer' }
                                : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                            }
                            title={canEdit(driver) ? (driver.status === 'active' ? 'Deaktivieren' : 'Aktivieren') : 'Nur für Admin oder Ersteller'}
                            aria-disabled={!canEdit(driver)}
                          >
                            {driver.status === 'active' ? <PowerOff size={18} /> : <Power size={18} />}
                          </button>
                          <button
                            onClick={() => canEdit(driver) && handleEdit(driver)}
                            disabled={!canEdit(driver)}
                            className="p-2 rounded-lg transition-all duration-200"
                            style={
                              canEdit(driver)
                                ? { color: 'var(--accent)', cursor: 'pointer' }
                                : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                            }
                            title={canEdit(driver) ? 'Bearbeiten' : 'Nur für Admin oder Ersteller'}
                            aria-disabled={!canEdit(driver)}
                          >
                            <Edit size={18} />
                          </button>
                          <button
                            onClick={() => canDelete(driver) && handleDelete(driver.id)}
                            disabled={!canDelete(driver)}
                            className="p-2 rounded-lg transition-all duration-200"
                            style={
                              canDelete(driver)
                                ? { color: 'var(--danger)', cursor: 'pointer' }
                                : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                            }
                            title={canDelete(driver) ? 'Löschen' : 'Nur für Admin oder Ersteller'}
                            aria-disabled={!canDelete(driver)}
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden" style={{ borderTop: '1px solid var(--border)' }}>
              {drivers.map((driver, index) => (
                <div
                  key={driver.id}
                  className="p-6 transition-all duration-200"
                  style={{
                    borderBottom: '1px solid var(--border)',
                    opacity: driver.status === 'inactive' ? 0.6 : 1
                  }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-3">
                      <div className="flex-shrink-0 h-12 w-12">
                        <div className={`h-12 w-12 rounded-full ${driver.status === 'active' ? 'bg-gradient-to-br from-blue-400 to-blue-600' : 'bg-gradient-to-br from-gray-400 to-gray-600'} flex items-center justify-center shadow-md`}>
                          <User className="h-6 w-6 text-white" />
                        </div>
                      </div>
                      <div>
                        <div className="text-base font-semibold flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-primary)' }}>
                          {driver.name}
                          {driver.employment_type === 'company_owner' && (
                            <span
                              className="px-2 py-0.5 text-xs font-semibold rounded-full"
                              style={{ background: 'rgba(16,185,129,0.12)', color: '#047857' }}
                            >
                              Inhaber
                            </span>
                          )}
                        </div>
                        <div className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          Fahrer #{index + 1}
                        </div>
                        <span
                          className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full mt-1"
                          style={
                            driver.status === 'active'
                              ? { background: 'var(--success-subtle)', color: 'var(--success)' }
                              : { background: 'var(--danger-subtle)', color: 'var(--danger)' }
                          }
                        >
                          {driver.status === 'active' ? 'Aktiv' : 'Inaktiv'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
                    Erstellt von: {driver.createdBy || 'Unbekannt'}
                  </div>
                  <div className="flex space-x-2">
                    <button
                      onClick={() => canEdit(driver) && handleToggleStatus(driver)}
                      disabled={!canEdit(driver)}
                      className="flex-1 p-2 rounded-lg transition-all duration-200"
                      style={
                        canEdit(driver)
                          ? { color: driver.status === 'active' ? 'var(--warning)' : 'var(--success)', cursor: 'pointer' }
                          : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                      }
                      title={canEdit(driver) ? (driver.status === 'active' ? 'Deaktivieren' : 'Aktivieren') : 'Nur für Admin oder Ersteller'}
                      aria-disabled={!canEdit(driver)}
                    >
                      {driver.status === 'active' ? <PowerOff size={18} /> : <Power size={18} />}
                    </button>
                    <button
                      onClick={() => canEdit(driver) && handleEdit(driver)}
                      disabled={!canEdit(driver)}
                      className="flex-1 p-2 rounded-lg transition-all duration-200"
                      style={
                        canEdit(driver)
                          ? { color: 'var(--accent)', cursor: 'pointer' }
                          : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                      }
                      title={canEdit(driver) ? 'Bearbeiten' : 'Nur für Admin oder Ersteller'}
                      aria-disabled={!canEdit(driver)}
                    >
                      <Edit size={18} />
                    </button>
                    <button
                      onClick={() => canDelete(driver) && handleDelete(driver.id)}
                      disabled={!canDelete(driver)}
                      className="flex-1 p-2 rounded-lg transition-all duration-200"
                      style={
                        canDelete(driver)
                          ? { color: 'var(--danger)', cursor: 'pointer' }
                          : { color: 'var(--text-tertiary)', cursor: 'not-allowed', opacity: 0.5 }
                      }
                      title={canDelete(driver) ? 'Löschen' : 'Nur für Admin oder Ersteller'}
                      aria-disabled={!canDelete(driver)}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Modal */}
      <DriverModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingDriver(undefined);
        }}
        onSave={handleSave}
        driver={editingDriver}
        title={editingDriver ? 'Fahrer bearbeiten' : 'Neuer Fahrer'}
      />
    </div>
  );
};

export default DriversManagement;
