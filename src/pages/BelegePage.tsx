import React, { useState, useEffect, type ReactNode } from 'react';
import { Download, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { Receipt, Driver } from '../types/receipt';
import ReceiptList, { PdfFilterInfo } from '../components/ReceiptList';
import ReceiptModal from '../components/ReceiptModal';
import { Alert, Button, ConfirmDialog, DataTable, KpiCard, PageHeader } from '../components/ui';
import { exportToExcel } from '../utils/excelExport';
import { handleDatabaseError } from '../utils/errorHandler';
import { generateReceiptPdf } from '../utils/receiptPdf';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';

interface ConfirmModalState {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  type: 'confirm' | 'warning';
}

const BelegePage: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuth();
  // The rights of the company the session is in: a read context writes nothing
  // (plan 3.4b), and the database refuses these three the same way.
  const { canEdit, canDelete, canCreate } = useCompanyScope();
  const { success, error: showError } = useToast();
  const { receipts: receiptActions, drivers: driverActions, isLoading: dbLoading, isConnected: dbConnected } = useDatabase();
  const { settings } = useCompanySettings();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  const [userDisplayNames, setUserDisplayNames] = useState<Map<string, string>>(new Map());
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<Receipt | null>(null);
  const [filteredReceipts, setFilteredReceipts] = useState<Receipt[]>([]);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    type: 'confirm'
  });

  const canEditReceipt = (receipt: Receipt): boolean => canEdit(receipt.createdBy);
  const canDeleteReceipt = (receipt: Receipt): boolean => canDelete(receipt.createdBy);

  useEffect(() => {
    if (!dbLoading) loadData();
  }, [dbLoading]);

  useEffect(() => {
    setFilteredReceipts(receipts);
  }, [receipts]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [receiptsData, driversData, profilesRes] = await Promise.all([
        receiptActions.get(),
        driverActions.get(),
        supabase.from('user_profiles').select('user_id, full_name, email'),
      ]);
      setReceipts(receiptsData);
      setDrivers(driversData);
      const nameMap = new Map<string, string>();
      for (const p of profilesRes.data ?? []) {
        const display = (p.full_name as string | null)?.trim() || (p.email as string | null)?.trim() || '';
        if (p.user_id && display) nameMap.set(p.user_id as string, display);
      }
      setUserDisplayNames(nameMap);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddReceipt = async (receiptData: Omit<Receipt, 'id'>) => {
    if (!canCreate) {
      showError(t('common.noPermission'), t('belege.noPermissionAdd'));
      return;
    }
    try {
      await receiptActions.add(receiptData);
      await loadData();
    } catch (err) {
      console.error('Error adding receipt:', err);
      showError(t('common.errorCreate'), handleDatabaseError(err));
    }
  };

  const handleUpdateReceipt = async (id: string, receiptData: Omit<Receipt, 'id'>) => {
    try {
      await receiptActions.update(id, receiptData);
      await loadData();
      setEditingReceipt(null);
      setIsReceiptModalOpen(false);
      success(t('belege.updated'), t('belege.updatedBody'));
    } catch (err) {
      console.error('Error updating receipt:', err);
      showError(t('common.errorUpdate'), handleDatabaseError(err));
    }
  };

  const handleDeleteReceipt = (id: string) => {
    const receipt = receipts.find(r => r.id === id);
    if (!receipt) return;

    setConfirmModal({
      isOpen: true,
      title: t('belege.deleteTitle'),
      message: t('belege.deleteMessage', { number: receipt.receiptNumber }),
      onConfirm: async () => {
        try {
          await receiptActions.delete(id);
          await loadData();
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
          success(t('belege.deleted'), t('belege.deletedBody'));
        } catch (err) {
          console.error('Error deleting receipt:', err);
          showError(t('common.errorDelete'), handleDatabaseError(err));
        }
      },
      type: 'confirm'
    });
  };

  const handleEditReceipt = (receipt: Receipt) => {
    setEditingReceipt(receipt);
    setIsReceiptModalOpen(true);
  };

  const handleExportExcel = () => {
    const toExport = filteredReceipts.length > 0 ? filteredReceipts : receipts;
    exportToExcel(toExport, 0, filteredReceipts.length > 0);
  };

  const handleDownloadPdf = (filtered: Receipt[], filterInfo: PdfFilterInfo) => {
    generateReceiptPdf(filtered, {
      ...filterInfo,
      companyName: settings?.company_name || 'El-Professor'
    });
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, but for one line:
  // useDatabase() is also asked for `isConnected`, which it has always computed.
  // When its connection test fails, the hook serves the lists from local
  // storage, which nothing writes, so the screen showed "Keine Belege
  // vorhanden" and 0,00 € for a database it never reached. It now says so and
  // shows no figure (a read that fails after a successful connection test is
  // still swallowed inside useDatabase; see HANDOFF.md). Everything below only
  // draws.

  const header = (actions?: ReactNode) => <PageHeader title={t('nav.belege')} actions={actions} />;

  if (loading || dbLoading) {
    return (
      <div className="font-ui">
        {header()}
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <KpiCard label={t('rec.totalExpenses')} value="" loading />
            <KpiCard label={t('rec.sumVat19')} value="" loading />
          </div>
          <DataTable
            caption={t('rec.tableCaption')}
            columns={[
              { id: 'date', header: t('common.date'), hideBelow: 'sm' },
              { id: 'description', header: t('rec.bookingText') },
              { id: 'expense', header: t('common.expenses'), kind: 'currency' },
            ]}
            rows={[]}
            getRowId={() => ''}
            loading
          />
        </div>
      </div>
    );
  }

  if (!dbConnected) {
    return (
      <div className="font-ui">
        {header()}
        <Alert
          tone="critical"
          title={t('belege.loadFailedTitle')}
          action={
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              <RotateCw aria-hidden />
              {t('belege.reload')}
            </Button>
          }
        >
          {t('belege.loadFailedBody')}
        </Alert>
      </div>
    );
  }

  return (
    <div className="font-ui">
      {header(
        <>
          <Button variant="secondary" onClick={handleExportExcel}>
            <Download aria-hidden />
            {t('common.exportExcelShort')}
          </Button>
          {/* A read context, or a role without the right, adds nothing (plan
              3.4b); handleAddReceipt refuses it as well. */}
          {canCreate ? (
            <Button
              onClick={() => {
                setEditingReceipt(null);
                setIsReceiptModalOpen(true);
              }}
            >
              <Plus aria-hidden />
              {t('belege.add')}
            </Button>
          ) : null}
        </>,
      )}

      <ReceiptList
        receipts={receipts}
        drivers={drivers}
        onEdit={handleEditReceipt}
        onDelete={handleDeleteReceipt}
        onExportFiltered={(filtered) => setFilteredReceipts(filtered)}
        onDownloadPdf={handleDownloadPdf}
        canEdit={canEditReceipt}
        canDelete={canDeleteReceipt}
        userDisplayNames={userDisplayNames}
      />

      {isReceiptModalOpen && (
        <ReceiptModal
          isOpen={isReceiptModalOpen}
          onClose={() => {
            setIsReceiptModalOpen(false);
            setEditingReceipt(null);
          }}
          onSave={editingReceipt
            ? (data) => handleUpdateReceipt(editingReceipt.id, data)
            : handleAddReceipt
          }
          receipt={editingReceipt}
          title={editingReceipt ? t('belege.edit') : t('belege.new')}
          drivers={drivers}
          existingReceipts={receipts}
        />
      )}

      {/* The legacy ConfirmationModal's contract: confirm calls onConfirm and
          then onClose, unawaited. The message is built above, in German. */}
      <ConfirmDialog
        open={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        description={confirmModal.message}
        confirmLabel={t('common.delete')}
        icon={Trash2}
      />
    </div>
  );
};

export default BelegePage;
