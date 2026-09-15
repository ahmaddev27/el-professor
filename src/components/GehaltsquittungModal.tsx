import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Download, ExternalLink, FileUp, RotateCw, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
  formatDate,
  formatEuroCents,
} from './ui';
import { GehaltsquittungPreview, exportGehaltsquittungPdf } from './GehaltsquittungDocument';
import { ReceiptAlert, useRefusalMessage, useSignedCopyPicker } from './GehaltsquittungParts';
import { FLOW_STEPS, useGehaltsquittungFlow, type FlowStep, type GehaltsquittungFlow } from '../hooks/useGehaltsquittungFlow';
import { openSignedCopy, type ReceiptSalary } from '../lib/salaryCashReceipts';
import { toCents } from '../utils/money';
import type { BalanceFigures, ReceiptFigures } from '../utils/salaryCashReceipt';
import {
  buildReceiptDocumentText,
  receiptCompany,
  storedReceiptDocumentInput,
  type ReceiptDocumentText,
} from '../utils/salaryCashReceiptDocument';
import { balanceMayHaveChanged, snapshotFromFigures } from '../utils/salaryCashReceiptFlow';

/**
 * Gehaltsquittung (cash salary receipt): choose the driver and salary, see the
 * balance, enter the cash amount, preview the German receipt, confirm it once
 * through confirm_salary_cash_payment, then download the PDF and attach the
 * signed copy. The first screen on the design-system primitives.
 */

type Company = ReturnType<typeof receiptCompany>;

const STEP_KEYS: Record<FlowStep, TranslationKey> = {
  select: 'gq.step.select',
  amount: 'gq.step.amount',
  preview: 'gq.step.preview',
  done: 'gq.step.done',
};

const PAYMENT_STATUS_KEYS: Record<NonNullable<ReceiptSalary['payment_status']>, TranslationKey> = {
  unpaid: 'sal.status.unpaid',
  partially_paid: 'sal.status.partiallyPaid',
  paid: 'sal.status.fullyPaid',
};

const periodLabel = (row: { period_start: string; period_end: string }) =>
  `${formatDate(row.period_start)} – ${formatDate(row.period_end)}`;

export interface GehaltsquittungModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After a receipt is issued or its signed copy attached, so a list can refresh. */
  onChanged?: () => void;
}

export default function GehaltsquittungModal({ open, onOpenChange, onChanged }: GehaltsquittungModalProps) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { companyId, can } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const { settings } = useCompanySettings();

  // The RPCs act on the caller's own company and need edit rights on salaries
  // (current_role_permits('salaries', true)); say so before anything is typed.
  const sameCompany = Boolean(companyId) && effectiveCompanyId === companyId;
  const mayConfirm = can('salaries', 'edit');
  const blocked = !sameCompany ? 'company_mismatch' : !mayConfirm ? 'not_authorized' : null;

  const flow = useGehaltsquittungFlow({
    enabled: open && blocked === null,
    companyId,
    defaultPlace: settings?.default_signature_city || settings?.city || '',
    onChanged,
  });
  const company = useMemo(() => receiptCompany(settings), [settings]);
  const stepIndex = FLOW_STEPS.indexOf(flow.step);
  const width = blocked === null && flow.step === 'preview' ? 'max-w-4xl' : blocked === null && flow.step === 'amount' ? 'max-w-3xl' : 'max-w-xl';

  const handleOpenChange = (next: boolean) => {
    // Closing mid-send would hide whether the payment was booked.
    if (!next && flow.sending) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={width}>
        <DialogHeader>
          <DialogTitle>{t('gq.title')}</DialogTitle>
          <DialogDescription>
            {blocked
              ? t('gq.description')
              : t('gq.step.progress', {
                  current: stepIndex + 1,
                  total: FLOW_STEPS.length,
                  name: t(STEP_KEYS[flow.step]),
                })}
          </DialogDescription>
        </DialogHeader>

        {blocked ? (
          <>
            <ReceiptAlert tone="caution">{refusalMessage(blocked)}</ReceiptAlert>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">{t('common.close')}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <StepIndicator current={stepIndex} />
            {flow.step === 'select' ? <SelectStep flow={flow} /> : null}
            {flow.step === 'amount' ? <AmountStep flow={flow} /> : null}
            {flow.step === 'preview' ? <PreviewStep flow={flow} company={company} /> : null}
            {flow.step === 'done' ? <DoneStep flow={flow} company={company} /> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: number }) {
  // Decorative: the dialog description names the step in words.
  return (
    <ol aria-hidden className="grid grid-cols-4 gap-1.5">
      {FLOW_STEPS.map((step, index) => (
        <li key={step} className={cn('h-1 rounded-full', index <= current ? 'bg-brand' : 'bg-sunken')} />
      ))}
    </ol>
  );
}

function FieldSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5">
      <span className="sr-only" role="status">
        {t('common.loading')}
      </span>
      <Skeleton className="h-3.5 w-28" />
      <Skeleton className="h-9 w-full [@media(pointer:coarse)]:h-11" />
    </div>
  );
}

function LoadError({ onRetry, message }: { onRetry: () => void; message?: string }) {
  const { t } = useTranslation();
  return (
    <ReceiptAlert
      tone="critical"
      action={
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw aria-hidden />
          {t('gq.retry')}
        </Button>
      }
    >
      {message ?? t('gq.loadError')}
    </ReceiptAlert>
  );
}

// ── Step 1: driver and salary ───────────────────────────────────────────────

function SelectStep({ flow }: { flow: GehaltsquittungFlow }) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { drivers, salaries, balance, overlap } = flow;

  return (
    <>
      <div className="grid gap-4">
        {drivers.status === 'idle' || drivers.status === 'loading' ? <FieldSkeleton /> : null}
        {drivers.status === 'error' ? <LoadError onRetry={flow.reloadDrivers} /> : null}
        {drivers.status === 'ready' && drivers.data.length === 0 ? (
          <EmptyState size="sm" icon={Users} title={t('gq.noDrivers')} />
        ) : null}
        {drivers.status === 'ready' && drivers.data.length > 0 ? (
          <Field label={t('common.driver')} required>
            <Select value={flow.driverId} onValueChange={flow.selectDriver}>
              <SelectTrigger>
                <SelectValue placeholder={t('gq.driver.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {drivers.data.map(driver => (
                  <SelectItem key={driver.id} value={driver.id}>
                    {driver.status && driver.status !== 'active'
                      ? t('gq.driver.inactive', { name: driver.name })
                      : driver.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {salaries.status === 'loading' ? <FieldSkeleton /> : null}
        {salaries.status === 'error' ? <LoadError onRetry={flow.reloadSalaries} /> : null}
        {salaries.status === 'ready' && salaries.data.length === 0 ? (
          <EmptyState size="sm" title={t('gq.noSalaries.title')} description={t('gq.noSalaries.body')} />
        ) : null}
        {salaries.status === 'ready' && salaries.data.length > 0 ? (
          <Field label={t('gq.salary.label')} hint={t('gq.salary.hint')} required>
            <Select value={flow.salaryId} onValueChange={flow.selectSalary}>
              <SelectTrigger>
                <SelectValue placeholder={t('gq.salary.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {salaries.data.map(salary => (
                  <SelectItem key={salary.id} value={salary.id}>
                    {t('gq.salary.option', {
                      period: periodLabel(salary),
                      status: t(PAYMENT_STATUS_KEYS[salary.payment_status ?? 'unpaid']),
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {overlap ? (
          <ReceiptAlert tone="critical">
            {refusalMessage('overlapping_salary')} {t('gq.overlap.with', { period: periodLabel(overlap) })}
          </ReceiptAlert>
        ) : null}
        {balance.status === 'error' ? <LoadError onRetry={flow.reloadBalance} /> : null}
        {flow.salaryMissing ? <ReceiptAlert tone="critical">{refusalMessage('salary_not_found')}</ReceiptAlert> : null}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{t('common.cancel')}</Button>
        </DialogClose>
        <Button onClick={flow.goToAmount} disabled={!flow.canContinue} loading={balance.status === 'loading'}>
          {t('gq.next')}
          <ChevronRight aria-hidden />
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Step 2: balance, amount, date, place ────────────────────────────────────

const AMOUNT_ERROR_KEYS: Record<'invalid' | 'too_large' | 'overpayment', TranslationKey> = {
  invalid: 'gq.amount.invalid',
  too_large: 'gq.amount.tooLarge',
  overpayment: 'gq.refusal.overpayment',
};

function AmountStep({ flow }: { flow: GehaltsquittungFlow }) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { balanceFigures } = flow;
  const remaining = balanceFigures ? formatEuroCents(balanceFigures.remainingBeforeCents) : '';

  // An empty field is only an error once the user tried to go on; a wrong amount is one as soon as it is typed.
  let amountMessage: string | undefined;
  if (flow.amountError && flow.amountError !== 'already_paid' && (flow.amountText.trim() !== '' || flow.showMissing)) {
    amountMessage = t(AMOUNT_ERROR_KEYS[flow.amountError], { remaining });
  }
  let dateMessage: string | undefined;
  if (flow.dateProblem === 'future') dateMessage = t('gq.date.future');
  else if (flow.dateProblem === 'missing' && flow.showMissing) dateMessage = t('gq.date.missing');
  const placeMessage = flow.placeMissing && flow.showMissing ? t('gq.place.missing') : undefined;

  return (
    <>
      <div className="grid gap-5 md:grid-cols-2">
        {balanceFigures ? (
          <BalancePanel
            balance={balanceFigures}
            figures={flow.figures}
            driverName={flow.driver?.name ?? ''}
            period={flow.salary ? periodLabel(flow.salary) : ''}
          />
        ) : (
          <div className="grid content-start gap-3">
            <FieldSkeleton />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        <div className="grid content-start gap-4">
          {flow.refusal && balanceFigures ? (
            balanceMayHaveChanged(flow.refusal) ? (
              <ReceiptAlert tone="caution">{refusalMessage('stale_figures')}</ReceiptAlert>
            ) : (
              <ReceiptAlert tone="critical">{refusalMessage(flow.refusal, { remaining })}</ReceiptAlert>
            )
          ) : null}
          {flow.alreadyPaid ? <ReceiptAlert tone="caution">{refusalMessage('already_paid')}</ReceiptAlert> : null}

          <div className="grid gap-1">
            <Field label={t('gq.amount.label')} hint={t('gq.amount.hint', { remaining })} error={amountMessage} required>
              <Input
                inputMode="decimal"
                autoComplete="off"
                value={flow.amountText}
                onChange={event => flow.setAmountText(event.target.value)}
                disabled={flow.alreadyPaid || !balanceFigures}
              />
            </Field>
            {balanceFigures && balanceFigures.remainingBeforeCents > 0 ? (
              <Button variant="link" size="sm" className="justify-self-start" onClick={flow.fillRemaining}>
                {t('gq.amount.useRemaining')}
              </Button>
            ) : null}
          </div>

          <Field label={t('gq.date.label')} hint={t('gq.date.hint')} error={dateMessage} required>
            <Input
              type="date"
              max={flow.today}
              value={flow.paymentDate}
              onChange={event => flow.setPaymentDate(event.target.value)}
              disabled={flow.alreadyPaid}
            />
          </Field>

          <Field label={t('gq.place.label')} hint={t('gq.place.hint')} error={placeMessage} required>
            <Input
              value={flow.place}
              onChange={event => flow.setPlace(event.target.value)}
              autoComplete="address-level2"
              maxLength={120}
              disabled={flow.alreadyPaid}
            />
          </Field>
        </div>
      </div>

      <DialogFooter>
        <Button variant="secondary" onClick={flow.goBack}>
          <ArrowLeft aria-hidden />
          {t('common.back')}
        </Button>
        <Button onClick={flow.goToPreview} disabled={flow.alreadyPaid || !balanceFigures}>
          {t('gq.toPreview')}
          <ChevronRight aria-hidden />
        </Button>
      </DialogFooter>
    </>
  );
}

function BalancePanel({
  balance,
  figures,
  driverName,
  period,
}: {
  balance: BalanceFigures;
  figures: ReceiptFigures | null;
  driverName: string;
  period: string;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="gq-balance-heading" className="grid content-start gap-3 rounded-surface border border-line bg-sunken/40 p-4">
      <div>
        <h3 id="gq-balance-heading" className="text-sm font-semibold text-fg">
          {t('gq.balance.heading')}
        </h3>
        <p className="text-[13px] text-fg-muted">
          {driverName} · {period}
        </p>
      </div>
      <dl className="grid gap-1.5 text-sm">
        <BalanceRow label={t('gq.balance.due')} cents={balance.dueCents} />
        <BalanceRow label={t('gq.balance.paidBank')} cents={balance.paidBankCents} />
        <BalanceRow label={t('gq.balance.paidCashManual')} cents={balance.paidCashCents.manual} />
        <BalanceRow
          label={t('gq.balance.paidCashWeekly')}
          hint={t('gq.balance.paidCashWeeklyHint')}
          cents={balance.paidCashCents.weeklyCashDifference}
        />
        <BalanceRow label={t('gq.balance.paidCashReceipts')} cents={balance.paidCashCents.gehaltsquittung} />
        <BalanceRow label={t('gq.balance.remainingBefore')} cents={balance.remainingBeforeCents} strong />
        {figures ? (
          <>
            <BalanceRow label={t('gq.balance.thisPayment')} cents={figures.thisPaymentCents} />
            <BalanceRow label={t('gq.balance.remainingAfter')} cents={figures.remainingAfterCents} strong />
          </>
        ) : null}
      </dl>
      {figures ? (
        <Badge tone={figures.isPartial ? 'caution' : 'positive'} className="justify-self-start">
          {figures.isPartial ? t('gq.balance.partial') : t('gq.balance.settles')}
        </Badge>
      ) : null}
    </section>
  );
}

function BalanceRow({ label, hint, cents, strong = false }: { label: string; hint?: string; cents: number; strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', strong && 'border-t border-line pt-1.5')}>
      <dt className={cn('text-fg-muted', strong && 'font-semibold text-fg')}>
        {label}
        {hint ? <span className="block text-xs text-fg-subtle">{hint}</span> : null}
      </dt>
      <dd className={cn('whitespace-nowrap tabular-nums text-fg', strong && 'font-semibold')}>{formatEuroCents(cents)}</dd>
    </div>
  );
}

// ── Step 3: preview and confirmation ────────────────────────────────────────

function PreviewStep({ flow, company }: { flow: GehaltsquittungFlow; company: Company }) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const { figures, salary, driver, paymentDate, place } = flow;

  const text = useMemo((): ReceiptDocumentText | null => {
    if (!figures || !salary || !driver) return null;
    try {
      return buildReceiptDocumentText({
        status: 'preview',
        receiptNumber: null,
        company,
        driver: { name: driver.name, gender: driver.gender },
        periodStart: salary.period_start,
        periodEnd: salary.period_end,
        paymentDate,
        place,
        figures: snapshotFromFigures(figures),
      });
    } catch {
      return null;
    }
  }, [figures, salary, driver, paymentDate, place, company]);

  const uncertain = flow.attempt?.state === 'uncertain' && !flow.sending;
  const remaining = flow.balanceFigures ? formatEuroCents(flow.balanceFigures.remainingBeforeCents) : '';

  return (
    <>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_17rem] md:items-start">
        <div className="grid gap-3 md:order-2">
          <p className="text-[13px] text-fg-muted">{t('gq.preview.germanNote')}</p>
          {/* The sheet is scaled down; what is confirmed is repeated here at a readable size. */}
          {figures && driver ? (
            <dl className="grid gap-2.5 rounded-surface border border-line bg-sunken/40 p-3 text-sm">
              <SummaryRow label={t('common.driver')} value={driver.name} />
              <SummaryRow label={t('gq.balance.thisPayment')} value={formatEuroCents(figures.thisPaymentCents)} strong />
              {text ? <SummaryRow label={t('gq.preview.inWords')} value={text.amount.words} /> : null}
              <SummaryRow label={t('gq.balance.remainingAfter')} value={formatEuroCents(figures.remainingAfterCents)} />
              <SummaryRow label={t('gq.date.label')} value={formatDate(paymentDate)} />
              <SummaryRow label={t('gq.place.label')} value={place.trim()} />
            </dl>
          ) : null}
          <ReceiptAlert tone="caution">{t('gq.confirm.warning')}</ReceiptAlert>
          {flow.refusal ? (
            <ReceiptAlert tone="critical">
              {refusalMessage(flow.refusal, { remaining })}
              {uncertain ? <span className="mt-1 block">{t('gq.confirm.retryHint')}</span> : null}
            </ReceiptAlert>
          ) : null}
        </div>
        <div className="md:order-1">
          {text ? (
            <GehaltsquittungPreview text={text} label={t('gq.preview.label')} />
          ) : (
            <ReceiptAlert tone="critical">{refusalMessage('unexpected')}</ReceiptAlert>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="secondary" onClick={flow.goBack} disabled={flow.sending || uncertain || flow.conflict}>
          <ArrowLeft aria-hidden />
          {t('common.back')}
        </Button>
        {flow.conflict ? (
          <DialogClose asChild>
            <Button>{t('common.close')}</Button>
          </DialogClose>
        ) : (
          <Button onClick={() => void flow.confirm()} loading={flow.sending} disabled={!text}>
            {uncertain ? <RotateCw aria-hidden /> : null}
            {uncertain ? t('gq.retry') : t('gq.confirm.button')}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function SummaryRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cn('text-fg [overflow-wrap:anywhere]', strong && 'text-base font-semibold tabular-nums')}>{value}</dd>
    </div>
  );
}

// ── Step 4: issued ──────────────────────────────────────────────────────────

function DoneStep({ flow, company }: { flow: GehaltsquittungFlow; company: Company }) {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const picker = useSignedCopyPicker();
  const [exporting, setExporting] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const { receipt, driver } = flow;

  if (!receipt || !driver) return null;
  const receiptDriver = { name: driver.name, gender: driver.gender };

  const downloadPdf = async () => {
    setExporting(true);
    setPdfFailed(false);
    try {
      await exportGehaltsquittungPdf(buildReceiptDocumentText(storedReceiptDocumentInput(receipt, receiptDriver, company)));
    } catch {
      setPdfFailed(true);
    } finally {
      setExporting(false);
    }
  };

  const viewCopy = async () => {
    if (!receipt.signed_copy_path) return;
    setOpenFailed(!(await openSignedCopy(receipt.signed_copy_path)));
  };

  return (
    <>
      <div className="grid gap-4">
        <ReceiptAlert tone="positive" title={t('gq.done.title', { number: receipt.receipt_number })}>
          {t('gq.done.body', {
            amount: formatEuroCents(toCents(receipt.amount)),
            driver: driver.name,
            period: periodLabel(receipt),
          })}
        </ReceiptAlert>
        {flow.differsFromPreview ? <ReceiptAlert tone="caution">{t('gq.done.differs')}</ReceiptAlert> : null}

        <div className="grid justify-items-start gap-2">
          <Button onClick={() => void downloadPdf()} loading={exporting}>
            {exporting ? null : <Download aria-hidden />}
            {exporting ? t('gq.pdf.exporting') : t('gq.pdf.download')}
          </Button>
          {pdfFailed ? <ReceiptAlert tone="critical">{t('gq.pdf.failed')}</ReceiptAlert> : null}
        </div>

        <section aria-labelledby="gq-signed-heading" className="grid gap-3 rounded-surface border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="gq-signed-heading" className="text-sm font-semibold text-fg">
              {t('gq.signed.heading')}
            </h3>
            <Badge tone={receipt.signed_copy_path ? 'positive' : 'caution'}>
              {receipt.signed_copy_path ? t('gq.signed.present') : t('gq.signed.missing')}
            </Badge>
          </div>
          <p className="text-[13px] text-fg-muted">{t('gq.signed.hint')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={flow.uploading}
              onClick={() => picker.pick(file => void flow.uploadCopy(file))}
            >
              {flow.uploading ? null : <FileUp aria-hidden />}
              {flow.uploading
                ? t('gq.signed.uploading')
                : receipt.signed_copy_path
                  ? t('gq.signed.replace')
                  : t('gq.action.upload')}
            </Button>
            {receipt.signed_copy_path ? (
              <Button variant="ghost" onClick={() => void viewCopy()}>
                <ExternalLink aria-hidden />
                {t('gq.action.view')}
              </Button>
            ) : null}
          </div>
          {picker.input}
          {flow.uploaded ? <ReceiptAlert tone="positive">{t('gq.signed.uploaded')}</ReceiptAlert> : null}
          {flow.uploadRefusal ? <ReceiptAlert tone="critical">{refusalMessage(flow.uploadRefusal)}</ReceiptAlert> : null}
          {openFailed ? <ReceiptAlert tone="critical">{t('gq.signed.openFailed')}</ReceiptAlert> : null}
        </section>
      </div>

      <DialogFooter>
        <Button variant="secondary" onClick={flow.startAnother}>
          {t('gq.done.another')}
        </Button>
        <DialogClose asChild>
          <Button>{t('common.close')}</Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
