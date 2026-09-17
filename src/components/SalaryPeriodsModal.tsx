import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Pencil, Trash2, X } from 'lucide-react';
import { Salary } from '../types/receipt';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import ConfirmationModal from './ConfirmationModal';
import { handleDatabaseError } from '../utils/errorHandler';
import { findOverlappingSalaryPeriods } from '../utils/salaryPeriodOverlap';
import {
  findSalaryDeletionBlock,
  findSalaryPeriodProblem,
  formatSalaryDue,
  formatStoredDate,
  formatStoredPeriod,
  rowCoveringPeriod,
  salaryPeriodChanged,
  type SalaryDeletionBlock,
  type SalaryRowWriteRefusal,
} from '../utils/salaryRowEdit';

/**
 * Merging a driver's overlapping salary rows: edit a row's period, or delete a
 * row that nothing hangs off.
 *
 * The owner decided on 17.09.2026 that he merges such rows himself. Since #69
 * every cash payment goes through `confirm_salary_cash_payment`, which refuses
 * a salary whose period overlaps another row of the same driver
 * (`overlapping_salary`), so a driver with an unmerged pair can take no cash
 * payment at all. #71 marks the pairs; this is the half that acts on them —
 * and `sal.payment.cashBlockedOverlap`, written by #71, already sends the owner
 * to the Gehälter screen to do it.
 *
 * **Why this dialog and not SalaryDetailsModal.** The salaries table shows one
 * line per driver for the *selected* period, and the row a period overlaps is
 * usually outside it. A merge needs both sides in reach at once, so this lists
 * every salary row of the one driver, whatever the page's period filter says —
 * folded out of the rows the screen already loaded, so no query is added for
 * them. SalaryDetailsModal knows one salary, and opening it calls
 * `ensureSalaryExists`, which *creates* a row: the last thing a screen for
 * removing duplicates should do.
 *
 * Two queries are added, both for the deletion rules, both batched over the
 * driver's rows rather than issued per row.
 */

interface SalaryPeriodsModalProps {
  isOpen: boolean;
  onClose: () => void;
  driverName: string;
  /** Every salary row of this driver, from the rows the screen already holds. */
  rows: Salary[];
  companyId: string | null;
  /** Why this caller may not write, from `salaryRowWriteRefusal`; null when they may. */
  writeRefusal: SalaryRowWriteRefusal | null;
  /** Reload the screen's rows after a successful write. */
  onChanged: () => Promise<unknown> | void;
}

interface RowFacts {
  payments: { source_type?: string | null }[];
  receipts: { status?: string | null }[];
}

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftStart, setDraftStart] = useState('');
  const [draftEnd, setDraftEnd] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Salary | null>(null);

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
      setEditingId(null);
      setDeleteTarget(null);
      return;
    }
    void loadFacts();
    // rowIdsKey rather than the array: a reload that returns the same rows must
    // not re-query, and one that changes them must.
  }, [isOpen, rowIdsKey, companyId]);

  /**
   * What hangs off each row, for the deletion rules. Both reads are scoped to
   * the company as well as the rows, so a stale id from another tenant cannot
   * widen them; RLS refuses that anyway, and an empty answer would otherwise
   * read as "nothing hangs off this row".
   *
   * A failed read is remembered, not swallowed: with no facts the dialog must
   * not claim a row is safe to delete.
   */
  const loadFacts = async () => {
    if (rowIds.length === 0 || !companyId) {
      setFacts(new Map());
      setFactsFailed(false);
      return;
    }
    setFactsLoading(true);
    setFactsFailed(false);
    try {
      const [payments, receipts] = await Promise.all([
        supabase
          .from('salary_payments')
          .select('id, salary_id, source_type')
          .eq('company_id', companyId)
          .in('salary_id', rowIds),
        supabase
          .from('salary_cash_receipts')
          .select('id, salary_id, status')
          .eq('company_id', companyId)
          .in('salary_id', rowIds),
      ]);

      if (payments.error) throw payments.error;
      if (receipts.error) throw receipts.error;

      const next = new Map<string, RowFacts>();
      for (const id of rowIds) next.set(id, { payments: [], receipts: [] });
      for (const payment of payments.data ?? []) next.get(payment.salary_id)?.payments.push(payment);
      for (const receipt of receipts.data ?? []) next.get(receipt.salary_id)?.receipts.push(receipt);
      setFacts(next);
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
    if (!rowFacts) return null;
    return findSalaryDeletionBlock(rowFacts);
  };

  const blockMessage = (block: SalaryDeletionBlock): string =>
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
        );

  /** Why this row's delete button is off, or null when it is on. */
  const deleteBlockedBecause = (row: Salary): string | null => {
    if (writeRefusal) return t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized');
    if (factsLoading) return t('sal.periods.checking');
    if (factsFailed || !facts.has(row.id)) return t('sal.periods.checkFailed');
    const block = blockFor(row);
    return block ? blockMessage(block) : null;
  };

  const startEdit = (row: Salary) => {
    setEditingId(row.id);
    setDraftStart(row.period_start);
    setDraftEnd(row.period_end);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftStart('');
    setDraftEnd('');
  };

  /** The live problem with what is typed, so Save is off before it is pressed. */
  const draftProblem = useMemo(
    () =>
      editingId
        ? findSalaryPeriodProblem({ period_start: draftStart, period_end: draftEnd }, driverRows, editingId)
        : null,
    [editingId, draftStart, draftEnd, driverRows],
  );

  const draftProblemMessage = (): string | null => {
    if (!draftProblem) return null;
    if (draftProblem.reason === 'incomplete') return t('sal.periods.problem.incomplete');
    if (draftProblem.reason === 'reversed') return t('sal.periods.problem.reversed');
    return t('sal.periods.problem.overlap', {
      periods: draftProblem.conflicts.map(formatStoredPeriod).join(', '),
    });
  };

  const handleSave = async (row: Salary) => {
    if (writeRefusal) {
      showError(
        t('common.noPermission'),
        t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized'),
      );
      return;
    }
    if (draftProblem) return;

    const draft = { period_start: draftStart, period_end: draftEnd };
    if (!salaryPeriodChanged(row, draft)) {
      cancelEdit();
      return;
    }

    setSaving(true);
    try {
      // `.select()` is not decoration: an UPDATE a policy refuses removes no row
      // and reports no error, so without reading back what changed the dialog
      // would report a save the database never made.
      const { data, error } = await supabase
        .from('salaries')
        .update({ period_start: draftStart, period_end: draftEnd })
        .eq('id', row.id)
        .eq('company_id', companyId)
        .select('id');

      if (error) throw error;
      if (!data || data.length === 0) {
        showError(t('common.errorUpdate'), t('sal.periods.writeRefused'));
        return;
      }

      cancelEdit();
      await onChanged();
      success(t('sal.periods.saved'), t('sal.periods.savedMessage', {
        name: driverName,
        period: formatStoredPeriod(draft),
      }));
    } catch (err) {
      console.error('Error updating salary period:', err);
      showError(t('common.errorUpdate'), writeErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  /**
   * The two constraints a period edit or a delete can still hit after the
   * checks above, named rather than shown raw.
   *
   * 23505 is `unique_driver_period UNIQUE (driver_id, period_start)`: another
   * row of this driver already starts on that day. The overlap check catches it
   * in every case it can see, so reaching this means the screen's copy of the
   * rows is stale.
   *
   * 23503 is `salary_cash_receipts.salary_id ON DELETE RESTRICT`, the same
   * refusal `findSalaryDeletionBlock` makes — reached only if a receipt was
   * issued after the facts were read.
   */
  const writeErrorMessage = (err: unknown): string => {
    const code = (err as { code?: string } | null | undefined)?.code;
    if (code === '23505') return t('sal.periods.error.duplicateStart');
    if (code === '23503') return t('sal.periods.error.receiptExists');
    return handleDatabaseError(err);
  };

  const handleDelete = async () => {
    const row = deleteTarget;
    if (!row) return;

    // Checked again at the moment of the delete, not only when the button was
    // drawn: the dialog stays open while the owner works through several rows.
    const blocked = deleteBlockedBecause(row);
    if (blocked) {
      showError(t('common.errorDelete'), blocked);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('salaries')
        .delete()
        .eq('id', row.id)
        .eq('company_id', companyId)
        .select('id');

      if (error) throw error;
      if (!data || data.length === 0) {
        showError(t('common.errorDelete'), t('sal.periods.writeRefused'));
        return;
      }

      await onChanged();
      success(t('sal.periods.deleted'), t('sal.periods.deletedMessage', {
        name: driverName,
        period: formatStoredPeriod(row),
      }));
    } catch (err) {
      console.error('Error deleting salary row:', err);
      showError(t('common.errorDelete'), writeErrorMessage(err));
    }
  };

  /**
   * The question, then what the driver is left with. Joined by a space, not a
   * newline: ConfirmationModal renders the message in a plain `<p>`, where HTML
   * collapses a line break anyway.
   */
  const deleteMessage = (row: Salary): string => {
    const covering = rowCoveringPeriod(row, driverRows, row.id);
    const consequence = covering
      ? t('sal.periods.confirmDelete.covered', { period: formatStoredPeriod(covering) })
      : t('sal.periods.confirmDelete.uncovered');
    const question = t('sal.periods.confirmDelete.message', {
      name: driverName,
      period: formatStoredPeriod(row),
      amount: formatSalaryDue(row),
    });
    return `${question} ${consequence}`;
  };

  if (!isOpen) return null;

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)',
    border: '1px solid var(--border)',
    borderRadius: '0.5rem',
    color: 'var(--text-primary)',
    fontSize: '0.875rem',
    padding: '0.375rem 0.5rem',
    outline: 'none',
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t('sal.periods.title', { name: driverName })}
      >
        <div
          className="rounded-xl shadow-xl w-full max-w-4xl my-8"
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
            <p
              className="text-sm rounded-lg px-3 py-2"
              style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}
            >
              {t('sal.periods.amountsNote')}
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
                    const editing = editingId === row.id;
                    const problem = editing ? draftProblemMessage() : null;

                    return (
                      <tr key={row.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td className="px-3 py-3 text-sm" style={{ color: 'var(--text-primary)' }}>
                          {editing ? (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                  {t('sal.from')}
                                </label>
                                <input
                                  type="date"
                                  value={draftStart}
                                  onChange={event => setDraftStart(event.target.value)}
                                  style={inputStyle}
                                  aria-label={t('sal.from')}
                                />
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                  {t('sal.to')}
                                </label>
                                <input
                                  type="date"
                                  value={draftEnd}
                                  onChange={event => setDraftEnd(event.target.value)}
                                  style={inputStyle}
                                  aria-label={t('sal.to')}
                                />
                              </div>
                              {problem && (
                                <p className="text-xs" style={{ color: 'var(--danger)' }} role="alert">
                                  {problem}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="whitespace-nowrap">
                                {formatStoredDate(row.period_start)} – {formatStoredDate(row.period_end)}
                              </span>
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
                          )}
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
                              ? blockMessage(block)
                              : facts.has(row.id)
                                ? t('sal.periods.attached.none')
                                : t('sal.periods.checkFailed')}
                        </td>
                        <td className="px-3 py-3 text-right text-sm">
                          <div className="flex justify-end gap-2">
                            {editing ? (
                              <>
                                <button
                                  onClick={() => handleSave(row)}
                                  disabled={saving || !!draftProblem || !!writeRefusal}
                                  style={{
                                    color: draftProblem || saving || writeRefusal ? 'var(--text-tertiary)' : 'var(--success)',
                                    cursor: draftProblem || saving || writeRefusal ? 'not-allowed' : 'pointer',
                                  }}
                                  title={t('common.save')}
                                >
                                  <Check size={18} />
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  disabled={saving}
                                  style={{ color: 'var(--text-secondary)', cursor: 'pointer' }}
                                  title={t('common.cancel')}
                                >
                                  <X size={18} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => startEdit(row)}
                                  disabled={!!writeRefusal || editingId !== null}
                                  style={{
                                    color: writeRefusal || editingId !== null ? 'var(--text-tertiary)' : 'var(--accent)',
                                    cursor: writeRefusal || editingId !== null ? 'not-allowed' : 'pointer',
                                  }}
                                  title={
                                    writeRefusal
                                      ? t(`sal.periods.refusal.${writeRefusal}` as 'sal.periods.refusal.not_authorized')
                                      : t('sal.periods.edit')
                                  }
                                >
                                  <Pencil size={18} />
                                </button>
                                <button
                                  onClick={() => setDeleteTarget(row)}
                                  disabled={!!deleteBlocked || editingId !== null}
                                  style={{
                                    color: deleteBlocked || editingId !== null ? 'var(--text-tertiary)' : 'var(--danger)',
                                    cursor: deleteBlocked || editingId !== null ? 'not-allowed' : 'pointer',
                                  }}
                                  title={deleteBlocked ?? t('sal.periods.delete')}
                                >
                                  <Trash2 size={18} />
                                </button>
                              </>
                            )}
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
