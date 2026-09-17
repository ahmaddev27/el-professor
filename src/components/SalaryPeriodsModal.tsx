import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { Salary } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import ConfirmationModal from './ConfirmationModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { fetchAllPaginated } from '../utils/fetchAllPaginated';
import { findOverlappingSalaryPeriods } from '../utils/salaryPeriodOverlap';
import {
  findSalaryDeletionBlock,
  formatSalaryDue,
  formatStoredPeriod,
  type SalaryDeletionBlock,
  type SalaryRowWriteRefusal,
} from '../utils/salaryRowEdit';

/**
 * Merging a driver's overlapping salary rows: remove the row that should not
 * be there.
 *
 * The owner decided on 17.09.2026 that he merges such rows himself. Since #69
 * every cash payment goes through `confirm_salary_cash_payment`, which refuses
 * a salary whose period overlaps another row of the same driver
 * (`overlapping_salary`), so a driver with an unmerged pair can take no cash
 * payment at all. #71 marks the pairs; this is the half that acts on them —
 * and `sal.payment.cashBlockedOverlap`, written by #71, already sends the owner
 * to the Gehälter screen to do it.
 *
 * **The merge is a delete and nothing more.** The overlapping pair is a
 * hand-entered calendar month beside the business month the app itself
 * computes; removing the hand-entered one and leaving the business row
 * untouched is the whole operation, and it is the one path the rest of the
 * screen already understands. Widening the survivor instead looks like the
 * obvious alternative and is a trap — the reasons are in the header of
 * `utils/salaryRowEdit.ts`, and the first of them is that this screen matches a
 * stored row to the selected period by exact equality of both ends, so a
 * widened row falls out of its own table.
 *
 * **Why this dialog and not SalaryDetailsModal.** The salaries table shows one
 * line per driver for the *selected* period, and the row a period overlaps is
 * usually outside it. A merge needs both sides in reach at once, so this lists
 * every salary row of the one driver, whatever the page's period filter says —
 * folded out of the rows the screen already loaded, so no query is added for
 * them. SalaryDetailsModal knows one salary, and opening it calls
 * `ensureSalaryExists`, which *creates* a row: the last thing a screen for
 * removing duplicates should do.
 */

interface SalaryPeriodsModalProps {
  isOpen: boolean;
  onClose: () => void;
  driverName: string;
  /** Every salary row of this driver, from the rows the screen already holds. */
  rows: Salary[];
  companyId: string | null;
  /** Why this caller may not delete, from `salaryRowWriteRefusal`; null when they may. */
  writeRefusal: SalaryRowWriteRefusal | null;
  /** Reload the screen's rows after a successful delete. */
  onChanged: () => Promise<unknown> | void;
}

interface PaymentFact {
  salary_id: string;
  source_type?: string | null;
}

interface ReceiptFact {
  salary_id: string;
  status?: string | null;
}

interface RowFacts {
  payments: PaymentFact[];
  receipts: ReceiptFact[];
}

const emptyFacts = (): RowFacts => ({ payments: [], receipts: [] });

const SalaryPeriodsModal: React.FC<SalaryPeriodsModalProps> = ({
  isOpen,
  onClose,
  driverName,
  rows,
  companyId,
  writeRefusal,
  onChanged,
}) => {
  const { t, tPlural } = useTranslation();
  const { success, error: showError } = useToast();

  const [facts, setFacts] = useState<Map<string, RowFacts>>(new Map());
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsFailed, setFactsFailed] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Salary | null>(null);
  /** The row a delete is in flight for, so a second click cannot start another. */
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Earliest period first: the order the owner reads a driver's year in, and the
  // order that puts an overlapping pair next to each other.
  const driverRows = useMemo(
    () => [...rows].sort((left, right) => left.period_start.localeCompare(right.period_start)),
    [rows],
  );

  const rowIds = useMemo(() => driverRows.map(row => row.id), [driverRows]);
  const rowIdsKey = rowIds.join(',');

  useEffect(() => {
    if (!isOpen) {
      setDeleteTarget(null);
      return;
    }
    void loadFacts();
    // rowIdsKey rather than the array: a reload that returns the same rows must
    // not re-query, and one that changes them must.
  }, [isOpen, rowIdsKey, companyId]);

  /**
   * One row's children, read fresh. Both selects are paginated: PostgREST caps
   * a response at 1000 rows and reports no error when it truncates, and a
   * truncated payment list on this screen reads as "fewer payments hang off
   * this row than really do" — on a path that deletes them.
   *
   * Scoped to the company as well as the rows, so a stale id from another
   * tenant cannot widen them; RLS refuses that anyway, but an empty answer
   * would otherwise read as "nothing hangs off this row".
   */
  const readFacts = async (ids: string[]): Promise<Map<string, RowFacts>> => {
    const next = new Map<string, RowFacts>();
    for (const id of ids) next.set(id, emptyFacts());
    if (ids.length === 0 || !companyId) return next;

    const [payments, receipts] = await Promise.all([
      fetchAllPaginated<PaymentFact>(
        (from, to) => supabase
          .from('salary_payments')
          .select('id, salary_id, source_type')
          .eq('company_id', companyId)
          .in('salary_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'Gehaltszahlungen' },
      ),
      fetchAllPaginated<ReceiptFact>(
        (from, to) => supabase
          .from('salary_cash_receipts')
          .select('id, salary_id, status')
          .eq('company_id', companyId)
          .in('salary_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'Gehaltsquittungen' },
      ),
    ]);

    for (const payment of payments) next.get(payment.salary_id)?.payments.push(payment);
    for (const receipt of receipts) next.get(receipt.salary_id)?.receipts.push(receipt);
    return next;
  };

  /**
   * What hangs off each row, for the delete buttons.
   *
   * A failed read is remembered, not swallowed: with no facts the dialog must
   * not claim a row is safe to delete.
   */
  const loadFacts = async () => {
    setFactsLoading(true);
    setFactsFailed(false);
    try {
      setFacts(await readFacts(rowIds));
    } catch (err) {
      console.error('Error loading salary row facts:', err);
      setFacts(new Map());
      setFactsFailed(true);
      showError(t('common.errorLoad'), handleDatabaseError(err));
    } finally {
      setFactsLoading(false);
    }
  };

  const blockFor = (row: Salary): SalaryDeletionBlock | null => {
    const rowFacts = facts.get(row.id);
    return rowFacts ? findSalaryDeletionBlock(rowFacts) : null;
  };

  /**
   * Why a row cannot go, in a sentence that says what to do about it.
   *
   * The payments message carries the row's **own** period, because *Zahlungen
   * verwalten* opens the payments of the row matching the period selected on
   * the screen behind this dialog — not the row named here. Telling the owner
   * to "remove the payments first" without that step would send him to the
   * wrong row's payments and look like the product was lying to him.
   */
  const blockMessage = (block: SalaryDeletionBlock, row: Salary): string =>
    block.reason === 'gehaltsquittung'
      ? tPlural(
          {
            one: 'sal.periods.block.gehaltsquittung.one',
            other: 'sal.periods.block.gehaltsquittung.other',
          },
          // A gehaltsquittung payment whose receipt was not read counts as one,
          // so the sentence never says "0 Gehaltsquittungen".
          Math.max(block.receipts, 1),
        )
      : tPlural(
          { one: 'sal.periods.block.payments.one', other: 'sal.periods.block.payments.other' },
          block.payments,
          { period: formatStoredPeriod(row) },
        );

  /** Why this row's delete button is off, or null when it is on. */
  const deleteBlockedBecause = (row: Salary): string | null => {
    if (writeRefusal) return t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized');
    if (deletingId) return t('sal.periods.deleting');
    if (factsLoading) return t('sal.periods.checking');
    if (factsFailed || !facts.has(row.id)) return t('sal.periods.checkFailed');
    const block = blockFor(row);
    return block ? blockMessage(block, row) : null;
  };

  const handleDelete = async () => {
    const row = deleteTarget;
    if (!row || deletingId) return;

    if (writeRefusal) {
      showError(
        t('common.noPermission'),
        t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized'),
      );
      return;
    }

    setDeletingId(row.id);
    try {
      /*
       * The decision is re-taken against a **fresh** read of this one row's
       * children, not against the map loaded when the dialog opened.
       * `salary_payments.salary_id` is ON DELETE CASCADE, so a payment recorded
       * in another tab while this dialog sat open would be deleted with the row
       * and the dialog would report a clean success.
       *
       * This narrows the window; it does not close it. Between this read and
       * the DELETE below there is still a gap, and only a SECURITY DEFINER
       * function that checked and deleted in one transaction would remove it.
       * That is a migration and a decision for the owner, not something to slip
       * into a screen change.
       */
      const fresh = await readFacts([row.id]);
      setFacts(previous => {
        const merged = new Map(previous);
        merged.set(row.id, fresh.get(row.id) ?? emptyFacts());
        return merged;
      });

      const block = findSalaryDeletionBlock(fresh.get(row.id) ?? emptyFacts());
      if (block) {
        showError(t('common.errorDelete'), blockMessage(block, row));
        return;
      }

      const { data, error } = await supabase
        .from('salaries')
        .delete()
        .eq('id', row.id)
        .eq('company_id', companyId)
        .select('id');

      if (error) throw error;

      // A DELETE a policy refuses removes no row and reports no error, so zero
      // rows back has to be read rather than trusted. It has two causes, and
      // "someone else already deleted it" must not be reported as a permission
      // problem — so the row is looked for before blaming the caller.
      if (!data || data.length === 0) {
        const { data: stillThere } = await supabase
          .from('salaries')
          .select('id')
          .eq('id', row.id)
          .eq('company_id', companyId)
          .maybeSingle();

        if (stillThere) {
          showError(t('common.errorDelete'), t('sal.periods.writeRefused'));
          return;
        }
        // Gone already: the screen's copy is stale, so reload before saying so.
        await onChanged();
        showError(t('common.errorDelete'), t('sal.periods.alreadyGone'));
        return;
      }

      await onChanged();
      success(t('sal.periods.deleted'), t('sal.periods.deletedMessage', {
        name: driverName,
        period: formatStoredPeriod(row),
      }));
    } catch (err) {
      console.error('Error deleting salary row:', err);
      showError(t('common.errorDelete'), deleteErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  };

  /**
   * 23503 is `salary_cash_receipts.salary_id ON DELETE RESTRICT`, the same
   * refusal `findSalaryDeletionBlock` makes — reached only if a receipt was
   * issued between the fresh read above and the DELETE.
   */
  const deleteErrorMessage = (err: unknown): string => {
    const code = (err as { code?: string } | null | undefined)?.code;
    if (code === '23503') return t('sal.periods.error.receiptExists');
    return handleDatabaseError(err);
  };

  /**
   * The question, then which periods the driver keeps. Joined by a space, not a
   * newline: ConfirmationModal renders the message in a plain `<p>`, where HTML
   * collapses a line break anyway.
   *
   * It names the rows that remain rather than claiming anything about coverage.
   * An earlier draft warned when no single remaining period contained the one
   * being deleted, and that warning was false for the very case it appeared in:
   * a week belongs to the month containing its Monday, so `01.03.2026` belongs
   * to business February and `30.–31.03.` to business April, and the adjacent
   * business rows already hold those days. Printing "these days will be in no
   * salary record" is what would push the owner into widening a row.
   */
  const deleteMessage = (row: Salary): string => {
    const question = t('sal.periods.confirmDelete.message', {
      name: driverName,
      period: formatStoredPeriod(row),
      amount: formatSalaryDue(row),
    });
    const remaining = driverRows.filter(other => other.id !== row.id);
    const keeps = remaining.length === 0
      ? t('sal.periods.confirmDelete.keepsNothing')
      : t('sal.periods.confirmDelete.keeps', {
          periods: remaining.map(formatStoredPeriod).join(', '),
        });
    return `${question} ${keeps}`;
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t('sal.periods.title', { name: driverName })}
      >
        <div
          className="rounded-xl shadow-xl w-full max-w-3xl my-8"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        >
          <div
            className="flex items-center justify-between px-6 py-4"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('sal.periods.title', { name: driverName })}
            </h2>
            <button onClick={onClose} style={{ color: 'var(--text-secondary)' }} title={t('common.close')}>
              <X size={20} />
            </button>
          </div>

          <div className="px-6 py-4 space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('sal.periods.intro')}
            </p>
            {writeRefusal && (
              <p
                className="text-sm rounded-lg px-3 py-2"
                style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}
              >
                {t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized')}
              </p>
            )}
          </div>

          <div className="px-6 pb-6 overflow-x-auto">
            {driverRows.length === 0 ? (
              <p className="py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('sal.periods.none')}
              </p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th
                      className="px-3 py-2 text-left text-xs font-medium uppercase"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t('sal.periods.col.period')}
                    </th>
                    <th
                      className="px-3 py-2 text-right text-xs font-medium uppercase"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t('sal.periods.col.amount')}
                    </th>
                    <th
                      className="px-3 py-2 text-left text-xs font-medium uppercase"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t('sal.periods.col.attached')}
                    </th>
                    <th
                      className="px-3 py-2 text-right text-xs font-medium uppercase"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {t('sal.periods.col.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {driverRows.map(row => {
                    const overlaps = findOverlappingSalaryPeriods(row, driverRows, row.id);
                    const block = facts.has(row.id) ? blockFor(row) : null;
                    const deleteBlocked = deleteBlockedBecause(row);

                    return (
                      <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-3 py-3 text-sm" style={{ color: 'var(--text-primary)' }}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="whitespace-nowrap">{formatStoredPeriod(row)}</span>
                            {overlaps.length > 0 && (
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
                                style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}
                                title={overlaps.map(formatStoredPeriod).join('\n')}
                              >
                                <AlertTriangle size={12} aria-hidden />
                                {t('sal.overlap.badge')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td
                          className="px-3 py-3 text-sm text-right whitespace-nowrap"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {formatSalaryDue(row)} €
                        </td>
                        <td className="px-3 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {factsLoading
                            ? t('sal.periods.checking')
                            : block
                              ? blockMessage(block, row)
                              : facts.has(row.id)
                                ? t('sal.periods.attached.none')
                                : t('sal.periods.checkFailed')}
                        </td>
                        <td className="px-3 py-3 text-right text-sm">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setDeleteTarget(row)}
                              disabled={!!deleteBlocked}
                              style={{
                                color: deleteBlocked ? 'var(--text-tertiary)' : 'var(--danger)',
                                cursor: deleteBlocked ? 'not-allowed' : 'pointer',
                              }}
                              title={deleteBlocked ?? t('sal.periods.delete')}
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {t('sal.periods.mergeHint')}
            </p>
          </div>
        </div>
      </div>

      {/* ConfirmationModal calls onConfirm and then onClose, both synchronously
          and neither awaited, so the dialog is already closing while the delete
          is in flight. The outcome is reported by a toast, as it is wherever
          else this component is used with an async handler. */}
      <ConfirmationModal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('sal.periods.confirmDelete.title')}
        message={deleteTarget ? deleteMessage(deleteTarget) : ''}
        type="confirm"
        confirmText={t('common.delete')}
      />
    </>
  );
};

export default SalaryPeriodsModal;
