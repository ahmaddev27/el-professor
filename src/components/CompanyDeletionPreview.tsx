import { Alert } from './ui';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { HEADLINE_TABLES, otherRows, type DeletionPreview } from '../lib/platformCompanyDeletion';

/**
 * What "Endgültig löschen" will remove and what it will leave, as the database
 * counted it a moment ago. The numbers are the deletion's own plan
 * (`app_private.company_deletion_plan`), not a second count made in the browser,
 * so this list and the deletion cannot disagree.
 */

const LABELS: Record<typeof HEADLINE_TABLES[number], TranslationKey> = {
  drivers: 'sa.deletion.drivers',
  cars: 'sa.deletion.cars',
  fahrtenbuch_trips: 'sa.deletion.trips',
  income: 'sa.deletion.income',
  receipts: 'sa.deletion.receipts',
  salaries: 'sa.deletion.salaries',
  subscription_invoices: 'sa.deletion.invoices',
  partner_connections: 'sa.deletion.partner',
};

export type PreviewState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; preview: DeletionPreview };

export function CompanyDeletionPreview({ state }: { state: PreviewState }) {
  const { t } = useTranslation();

  if (state.status === 'loading') {
    return <p className="text-sm text-fg-muted" role="status">{t('sa.deletion.loading')}</p>;
  }
  if (state.status === 'failed') {
    return <Alert tone="critical" title={t('sa.deletion.loadFailed')}>{state.message}</Alert>;
  }

  const { preview } = state;
  const rows = HEADLINE_TABLES
    .map(table => ({ table, count: preview.tables[table] ?? 0 }))
    .filter(row => row.count > 0);
  const other = otherRows(preview);
  const remove = preview.accounts.filter(a => a.action === 'delete');
  const keep = preview.accounts.filter(a => a.action === 'keep');
  const { kept } = preview;
  const keptRecords = kept.activationCodes + kept.discountCodes + kept.activationCodeAttempts;

  return (
    <div className="space-y-4 text-sm" data-testid="company-deletion-preview">
      <section aria-labelledby="cd-goes">
        <h3 id="cd-goes" className="mb-1 font-semibold text-fg">{t('sa.deletion.goes')}</h3>
        <ul className="space-y-0.5 text-fg-muted">
          {rows.map(row => (
            <li key={row.table} className="flex justify-between gap-3">
              <span>{t(LABELS[row.table])}</span>
              <span className="tabular-nums">{row.count}</span>
            </li>
          ))}
          {other > 0 && (
            <li className="flex justify-between gap-3">
              <span>{t('sa.deletion.other')}</span>
              <span className="tabular-nums">{other}</span>
            </li>
          )}
          {preview.files > 0 && (
            <li className="flex justify-between gap-3">
              <span>{t('sa.deletion.files')}</span>
              <span className="tabular-nums">{preview.files}</span>
            </li>
          )}
          <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold text-fg">
            <span>{t('sa.deletion.total')}</span>
            <span className="tabular-nums">{preview.rowsTotal}</span>
          </li>
        </ul>
        {(preview.tables.income ?? 0) > 0 && (
          <p className="mt-1 text-xs text-fg-subtle">
            {t('sa.deletion.incomeSplit', { uber: preview.income.uber, other: preview.income.other })}
          </p>
        )}
      </section>

      <section aria-labelledby="cd-accounts">
        <h3 id="cd-accounts" className="mb-1 font-semibold text-fg">{t('sa.deletion.accounts')}</h3>
        {remove.length === 0 ? (
          <p className="text-fg-muted">{t('sa.deletion.accountsNone')}</p>
        ) : (
          <ul className="space-y-0.5 text-fg-muted">
            {remove.map(a => (
              <li key={a.userId} className="break-all">{a.email || a.userId}</li>
            ))}
          </ul>
        )}
        {remove.length > 0 && <p className="mt-1 text-xs text-fg-subtle">{t('sa.deletion.accountsFree')}</p>}
      </section>

      <section aria-labelledby="cd-kept">
        <h3 id="cd-kept" className="mb-1 font-semibold text-fg">{t('sa.deletion.kept')}</h3>
        <ul className="list-disc space-y-0.5 pl-5 text-fg-muted">
          {keep.map(a => (
            <li key={a.userId} className="break-all">{t('sa.deletion.keptStaff', { email: a.email || a.userId })}</li>
          ))}
          {keptRecords > 0 && (
            <li>{t('sa.deletion.keptCodes', { codes: kept.activationCodes, discounts: kept.discountCodes, attempts: kept.activationCodeAttempts })}</li>
          )}
          {kept.activationCodesWithAddress > 0 && (
            <li>{t('sa.deletion.keptAddress', { n: kept.activationCodesWithAddress })}</li>
          )}
          <li>{t('sa.deletion.keptAudit')}</li>
        </ul>
      </section>
    </div>
  );
}
