/**
 * Undo the Uber import: delete what the one import button created, and nothing
 * else (owner, 16.10.2026: he deletes and re-imports to get the trial right).
 *
 * ## The confirmation carries the information
 *
 * "Are you sure?" is worth nothing, so nothing is offered before the database
 * has been asked what it would delete (`uber_import_undo(true)`, a dry run of
 * the very plan the delete executes). The dialog shows those counts, the
 * period, which drivers and cars go, and which stay and why, and then asks for
 * the company's name, the pattern CompaniesPage's hard delete uses.
 *
 * ## A figure whose load failed is not shown
 *
 * If the preview cannot be read, or does not parse (`parseUndoPreview`), the
 * dialog says so and offers a retry and no delete. "0 rows will be deleted"
 * read off a failed request would be a claim.
 *
 * ## The delete is a Dialog, not a ConfirmDialog
 *
 * It must stay open while it works and show its own failure. The real run sends
 * back the counts the operator was shown; if the data moved in between, the
 * database refuses (`plan_changed`) and this asks for a fresh preview instead of
 * deleting something nobody looked at.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { TranslationKey } from '../../i18n';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  nothingToUndo,
  parseUndoPreview,
  parseUndoResult,
  summariseBlockers,
  undoErrorKey,
  type UndoPreview,
  type UndoRowKept,
} from '../../lib/uberImportUndo';
import {
  Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, Input, formatDate,
} from '../ui';

type Translate = ReturnType<typeof useTranslation>['t'];

type State =
  | { kind: 'closed' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; preview: UndoPreview; failure: TranslationKey | null }
  | { kind: 'running'; preview: UndoPreview }
  | { kind: 'done'; deleted: { income: number; drivers: number; cars: number }; kept: { drivers: number; cars: number } };

interface UndoImportCardProps {
  /** An administrator outside a read-only context; the database decides again. */
  mayUndo: boolean;
}

export function UndoImportCard({ mayUndo }: UndoImportCardProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'closed' });
  const [typed, setTyped] = useState('');
  // Only the newest request may install an answer.
  const latest = useRef(0);

  const loadPreview = async () => {
    const mine = ++latest.current;
    setTyped('');
    setState({ kind: 'loading' });
    try {
      const { data, error } = await supabase.rpc('uber_import_undo', { p_dry_run: true });
      if (mine !== latest.current) return;
      const preview = error ? null : parseUndoPreview(data);
      setState(preview ? { kind: 'ready', preview, failure: null } : { kind: 'failed' });
    } catch {
      if (mine === latest.current) setState({ kind: 'failed' });
    }
  };

  const close = () => {
    latest.current += 1;
    setState({ kind: 'closed' });
  };

  const run = async (preview: UndoPreview) => {
    const mine = ++latest.current;
    setState({ kind: 'running', preview });
    try {
      const { data, error } = await supabase.rpc('uber_import_undo', {
        p_dry_run: false,
        p_confirm_name: typed,
        p_expected: preview.expect,
      });
      if (mine !== latest.current) return;
      if (error) {
        const hint = (error as { hint?: string }).hint;
        setState({ kind: 'ready', preview, failure: undoErrorKey(hint) });
        return;
      }
      const result = parseUndoResult(data);
      // An answer without its counts is not "deleted 0": nothing says what happened.
      if (!result) {
        setState({ kind: 'ready', preview, failure: 'import.undo.err.unreadable' });
        return;
      }
      setState({
        kind: 'done',
        deleted: { income: result.income, drivers: result.drivers, cars: result.cars },
        kept: { drivers: result.keptDrivers, cars: result.keptCars },
      });
    } catch {
      if (mine === latest.current) setState({ kind: 'ready', preview, failure: 'import.undo.err.generic' });
    }
  };

  useEffect(() => () => { latest.current += 1; }, []);

  const open = state.kind !== 'closed';
  const running = state.kind === 'running';

  return (
    <Card className="font-ui">
      <CardHeader>
        <div className="min-w-0">
          <CardTitle as="h2">
            <span className="inline-flex items-center gap-2">
              <Trash2 className="size-4" aria-hidden />
              {t('import.undo.title')}
            </span>
          </CardTitle>
          <CardDescription>{t('import.undo.body')}</CardDescription>
        </div>
        <Button variant="danger" onClick={() => void loadPreview()} disabled={!mayUndo}>
          {t('import.undo.action')}
        </Button>
      </CardHeader>
      {!mayUndo ? (
        <CardContent>
          <p className="text-sm text-fg-muted">{t('import.adminOnly')}</p>
        </CardContent>
      ) : null}

      <Dialog open={open} onOpenChange={next => { if (!next && !running) close(); }}>
        <DialogContent className="max-w-xl" hideClose={running}>
          <DialogHeader>
            <DialogTitle>{t('import.undo.title')}</DialogTitle>
            <DialogDescription>{t('import.undo.dialogLead')}</DialogDescription>
          </DialogHeader>
          <DialogBody
            state={state}
            typed={typed}
            onTyped={setTyped}
            onRetry={() => void loadPreview()}
            onRun={preview => void run(preview)}
            onClose={close}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

interface DialogBodyProps {
  state: State;
  typed: string;
  onTyped: (value: string) => void;
  onRetry: () => void;
  onRun: (preview: UndoPreview) => void;
  onClose: () => void;
}

function DialogBody({ state, typed, onTyped, onRetry, onRun, onClose }: DialogBodyProps) {
  const { t } = useTranslation();

  if (state.kind === 'loading') {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('import.undo.loading')}
      </div>
    );
  }
  if (state.kind === 'failed') {
    return (
      <>
        <Alert tone="critical" title={t('import.undo.loadFailedTitle')}>{t('import.undo.loadFailedBody')}</Alert>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          <Button onClick={onRetry}>{t('import.undo.retry')}</Button>
        </DialogFooter>
      </>
    );
  }
  if (state.kind === 'done') {
    return (
      <>
        <Alert tone="positive" title={t('import.undo.doneTitle')}>
          {t('import.undo.doneBody', {
            income: String(state.deleted.income), drivers: String(state.deleted.drivers), cars: String(state.deleted.cars),
          })}
          {state.kept.drivers + state.kept.cars > 0
            ? ` ${t('import.undo.doneKept', { drivers: String(state.kept.drivers), cars: String(state.kept.cars) })}`
            : ''}
        </Alert>
        <DialogFooter><Button onClick={onClose}>{t('common.close')}</Button></DialogFooter>
      </>
    );
  }
  if (state.kind === 'closed') return null;

  const { preview } = state;
  const running = state.kind === 'running';
  const matches = typed.trim() === preview.companyName.trim() && preview.companyName.trim() !== '';
  const nothing = nothingToUndo(preview);
  const failure = state.kind === 'ready' ? state.failure : null;

  return (
    <>
      {nothing ? <Alert tone="neutral" title={t('import.undo.nothingTitle')}>{t('import.undo.nothingBody')}</Alert> : (
        <Alert tone="critical" title={t('import.undo.warnTitle')}>{t('import.undo.warnBody')}</Alert>
      )}
      <WillDelete preview={preview} />
      <WillKeep preview={preview} />
      {preview.salariesAffected > 0 && !nothing ? (
        <Alert tone="caution">{t('import.undo.salaries', { count: String(preview.salariesAffected) })}</Alert>
      ) : null}

      {failure ? (
        <Alert
          tone="critical"
          title={t('import.undo.failedTitle')}
          action={failure === 'import.undo.err.planChanged'
            ? <Button variant="secondary" size="sm" onClick={onRetry}>{t('import.undo.reload')}</Button> : undefined}
        >
          {t(failure)}
        </Alert>
      ) : null}

      {nothing ? (
        <DialogFooter><Button variant="secondary" onClick={onClose}>{t('common.close')}</Button></DialogFooter>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={event => { event.preventDefault(); if (matches && !running) onRun(preview); }}
        >
          <Field label={t('import.undo.confirmLabel', { name: preview.companyName })}>
            <Input
              value={typed}
              onChange={event => onTyped(event.target.value)}
              placeholder={t('import.undo.confirmPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              disabled={running}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={running}>{t('common.cancel')}</Button>
            <Button type="submit" variant="danger" loading={running} disabled={!matches || running}>
              {running ? t('import.undo.running') : t('import.undo.confirm')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </>
  );
}

function names(rows: Array<{ label: string }>): string {
  return rows.map(r => r.label).join(', ');
}

function WillDelete({ preview }: { preview: UndoPreview }) {
  const { t } = useTranslation();
  const { income, drivers, cars } = preview;
  return (
    <section className="grid gap-1.5">
      <h3 className="text-sm font-semibold text-fg">{t('import.undo.willDelete')}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>
          {income.rows === 0
            ? t('import.undo.noIncome')
            : t('import.undo.income', {
              rows: String(income.rows),
              from: formatDate(income.from ?? ''),
              to: formatDate(income.to ?? ''),
              drivers: String(income.drivers),
            })}
        </li>
        <li>{t('import.undo.drivers', { count: String(drivers.remove.length) })}{drivers.remove.length ? `: ${names(drivers.remove)}` : ''}</li>
        <li>{t('import.undo.cars', { count: String(cars.remove.length) })}{cars.remove.length ? `: ${names(cars.remove)}` : ''}</li>
      </ul>
    </section>
  );
}

function KeptRow({ row, t }: { row: UndoRowKept; t: Translate }) {
  return (
    <li>{t('import.undo.keptRow', { name: row.label, what: summariseBlockers(row.blockers, key => t(key)) })}</li>
  );
}

function WillKeep({ preview }: { preview: UndoPreview }) {
  const { t } = useTranslation();
  return (
    <section className="grid gap-1.5">
      <h3 className="text-sm font-semibold text-fg">{t('import.undo.willKeep')}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
        <li>{t('import.undo.keepHand', { count: String(preview.handTypedRows) })}</li>
        {preview.drivers.keep.map(row => <KeptRow key={row.id} row={row} t={t} />)}
        {preview.cars.keep.map(row => <KeptRow key={row.id} row={row} t={t} />)}
        {preview.drivers.untouched > 0 ? <li>{t('import.undo.keepFoundDrivers', { count: String(preview.drivers.untouched) })}</li> : null}
        {preview.cars.untouched > 0 ? <li>{t('import.undo.keepFoundCars', { count: String(preview.cars.untouched) })}</li> : null}
        <li>{t('import.undo.keepConnection')}</li>
      </ul>
    </section>
  );
}
