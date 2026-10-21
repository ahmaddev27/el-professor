import React, { useCallback, useState, useEffect, type ReactNode } from 'react';
import { DownloadCloud, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { pageWriteRights } from '../lib/pageWriteRights';
import { useToast } from '../contexts/ToastContext';
import { useDatabase } from '../hooks/useDatabase';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { Receipt, Driver } from '../types/receipt';
import ReceiptList, { PdfFilterInfo } from '../components/ReceiptList';
import ReceiptModal from '../components/ReceiptModal';
import {
  Alert,
  Button,
  ConfirmDialog,
  DataTable,
  KpiCard,
  PageHeader,
} from '../components/ui';
import { usePartnerCatchUp } from '../hooks/usePartnerCatchUp';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { buildBelegeExportOptions, type ReceiptExportFilters } from '../utils/belegeExport';
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
  const exportPicker = useColumnPickerExport();
  const { user } = useAuth();
  // The company whose data this screen queries, which is the opened one
  // inside a platform context and the membership otherwise (plan 3.4b).
  const { effectiveCompanyId } = useSuperAdmin();
  // The rights of the company the session is in: a read context writes nothing
  // (plan 3.4b), and the database refuses these three the same way.
  const scope = useCompanyScope();
  // The page the database asks (receipts), so the browser asks the same question.
  const { canEdit, canDelete, canCreate } = pageWriteRights('receipts', scope);
  const { success, error: showError } = useToast();
  const { receipts: receiptActions, drivers: driverActions, isLoading: dbLoading, isConnected: dbConnected } = useDatabase();
  const { settings } = useCompanySettings();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(false);
  const [userDisplayNames, setUserDisplayNames] = useState<Map<string, string>>(new Map());
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [editingReceipt, setEditingReceipt] = useState<Receipt | null>(null);
  // CLAUDE.md, "A figure whose load failed is not shown": one state, cleared
  // where the load starts and set in its existing catch, and the export withheld
  // while it is set. Without it a failed read wrote a workbook whose totals row
  // claimed 0,00 € for a company that has Belege.
  const [loadFailed, setLoadFailed] = useState(false);
  // Belege from the driver app are Belege the moment they arrive (owner,
  // 13.10.2026), so there is no inbox and nothing to accept. What can still be
  // waiting is one whose driver nobody has linked yet: it is recorded, and it
  // becomes a Beleg when the link is confirmed. null means "not known": a count
  // whose read failed must not be drawn as 0, which would claim nothing waits.
  const [waitingForLink, setWaitingForLink] = useState<number | null>(null);
  // The fleet the catch-up asks. Null means "no connection to ask", which is
  // also what a failed read leaves — and then the button is not drawn, which is
  // the honest outcome either way: there is nothing this screen can fetch.
  const [connection, setConnection] = useState<{ partner: string; fleet: string } | null>(null);
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

  const loadWaitingForLink = useCallback(async () => {
    if (!effectiveCompanyId) {
      setWaitingForLink(null);
      return;
    }
    const { count, error } = await supabase
      .from('partner_receipt_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', effectiveCompanyId)
      .eq('status', 'pending');
    setWaitingForLink(error ? null : count ?? 0);
  }, [effectiveCompanyId]);

  const loadConnection = useCallback(async () => {
    if (!effectiveCompanyId) {
      setConnection(null);
      return;
    }
    const { data } = await supabase
      .from('partner_connections')
      .select('partner, external_company_id')
      .eq('company_id', effectiveCompanyId)
      .neq('status', 'revoked')
      .limit(1)
      .maybeSingle();
    const fleet = (data?.external_company_id as string | null)?.trim() ?? '';
    // A connection recorded before the partner answered with an identity has
    // no fleet id, and there is nothing to fetch by — so it is not one.
    setConnection(data?.partner && fleet !== ''
      ? { partner: data.partner as string, fleet }
      : null);
  }, [effectiveCompanyId]);

  useEffect(() => { void loadConnection(); }, [loadConnection]);

  useEffect(() => { void loadWaitingForLink(); }, [loadWaitingForLink]);

  // The one recovery for a ring that never arrived (src/hooks/usePartnerCatchUp.ts):
  // it asks the partner what is waiting and ingests it. It outlived the inbox
  // because nothing else can retry a lost ring.
  const { catchUp, fetching, available: canCatchUp } = usePartnerCatchUp(connection);

  const loadData = async () => {
    setLoading(true);
    setLoadFailed(false);
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
      setLoadFailed(true);
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

  /*
    Belege are expenses. The old exportToExcel() built a "financial report" around
    income, a running balance, ROI and a profit/loss verdict — and Receipt carries
    none of those: it has `expense` and no `income`, no `balance`. So the function
    threw `TypeError: Cannot read properties of undefined (reading 'toFixed')`
    before writing a cell, for every company with at least one Beleg, with no
    try/catch and no error boundary — the click produced no file and no message.
    It is deleted now (the owner's decision D-E), and this uses
    exportTableToExcel, the generic dump six other screens already use
    (Fahrzeuge, Fahrer, Fixkosten, Benutzer, Bargeldbestand, Werkstatt). Per
    CLAUDE.md this dump is not a statutory form, so its headers follow the UI
    language like any other label.

    THE RULE THIS PRESERVES: the file holds the rows the operator is looking at,
    and says which filter produced them. The rows and the filter therefore arrive
    as arguments from the list that computed them — the same values, from the same
    binding, that the summary PDF beside it receives. This page no longer keeps a
    copy of the filtered list: it kept one, `filteredReceipts`, whose only writer
    was a callback nothing called, so the header's Excel button exported every
    Beleg the company had ever entered and stamped it "Gefilterte Auswahl".
  */
  const handleExportExcel = (rows: Receipt[], filters: ReceiptExportFilters) => {
    exportPicker.table('belege', buildBelegeExportOptions(rows, filters, t));
  };

  const handleDownloadPdf = (filtered: Receipt[], filterInfo: PdfFilterInfo) => {
    generateReceiptPdf(filtered, {
      ...filterInfo,
      // No fallback to the product's name: the PDF heads itself with the
      // company's own name or with nothing (owner, 01.10.2026).
      companyName: settings?.company_name ?? ''
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
      {/* The Excel button is no longer here. It sits in ReceiptList beside the
          summary PDF, because both write the filtered list and only that
          component knows what it is — from here the button could reach the rows
          on screen only through a copy, and the copy was the defect. */}
      {/* A read context, or a role without the right, adds nothing (plan 3.4b);
          handleAddReceipt refuses it as well. With the export moved out, this is
          the only header action left — so it is passed as itself rather than
          wrapped in a fragment, which PageHeader would render as an empty
          actions row for a reader who may not add. */}
      {header(
        canCreate || canCatchUp ? (
          <>
            {canCatchUp && (
              <Button
                variant="secondary"
                onClick={() => {
                  void (async () => {
                    if (await catchUp()) {
                      await loadData();
                      await loadWaitingForLink();
                    }
                  })();
                }}
                disabled={fetching}
                loading={fetching}
                title={t('partner.catchup.hint')}
              >
                <DownloadCloud aria-hidden />
                {t('partner.catchup.action')}
              </Button>
            )}
            {canCreate && (
              <Button
                onClick={() => {
                  setEditingReceipt(null);
                  setIsReceiptModalOpen(true);
                }}
              >
                <Plus aria-hidden />
                {t('belege.add')}
              </Button>
            )}
          </>
        ) : undefined,
      )}

      {/* One list. The driver app's Belege are in it beside the company's own,
          with the driver as the author (owner, 13.10.2026: no status, no
          review, always accepted). */}
      {waitingForLink !== null && waitingForLink > 0 && (
        <Alert
          tone="caution"
          title={t('belege.waitingForLink.title', { count: String(waitingForLink) })}
          className="mb-4"
        >
          {t('belege.waitingForLink.body')}
        </Alert>
      )}

      <ReceiptList
        receipts={receipts}
        drivers={drivers}
        onEdit={handleEditReceipt}
        onDelete={handleDeleteReceipt}
        onExportExcel={handleExportExcel}
        onDownloadPdf={handleDownloadPdf}
        canEdit={canEditReceipt}
        canDelete={canDeleteReceipt}
        userDisplayNames={userDisplayNames}
        exportDisabled={loadFailed}
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
