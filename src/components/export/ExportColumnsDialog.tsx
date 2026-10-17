import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui';
import type { ExportOptions } from '../../utils/excelExport';
import {
  loadRemembered,
  moveKey,
  orderForDisplay,
  resolveInitialSelection,
  validateSelection,
} from '../../utils/exportColumnSelection';

/** One table of an export request, with the id its choice is remembered under. */
export interface PickerSheet {
  tableId: string;
  options: ExportOptions;
}

export interface SheetChoice {
  tableId: string;
  selected: string[];
  available: string[];
}

interface SheetState {
  order: string[];
  checked: Set<string>;
}

const checkboxClass = 'size-4 shrink-0 cursor-pointer accent-brand';

function initialState(sheet: PickerSheet): SheetState {
  const available = sheet.options.columns.map(col => col.key);
  const selected = resolveInitialSelection(available, loadRemembered(sheet.tableId));
  return { order: orderForDisplay(available, selected), checked: new Set(selected) };
}

function selectedOf(state: SheetState): string[] {
  return state.order.filter(key => state.checked.has(key));
}

interface SheetListProps {
  sheet: PickerSheet;
  state: SheetState;
  heading: string | null;
  onChange: (next: SheetState) => void;
}

function SheetList({ sheet, state, heading, onChange }: SheetListProps) {
  const { t } = useTranslation();
  const labels = useMemo(
    () => new Map(sheet.options.columns.map(col => [col.key, col.label] as const)),
    [sheet],
  );
  const selectedCount = selectedOf(state).length;
  const setAll = (on: boolean) => onChange({ ...state, checked: new Set(on ? state.order : []) });
  const toggle = (key: string) => {
    const checked = new Set(state.checked);
    if (!checked.delete(key)) checked.add(key);
    onChange({ ...state, checked });
  };
  const move = (key: string, delta: -1 | 1) => onChange({ ...state, order: moveKey(state.order, key, delta) });

  return (
    <section className="grid grid-cols-1 gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-semibold text-fg">{heading}</h3>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-xs tabular-nums text-fg-subtle">
            {t('export.columns.count', { selected: selectedCount, total: state.order.length })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll(true)}>{t('export.columns.selectAll')}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAll(false)}>{t('export.columns.selectNone')}</Button>
        </div>
      </div>
      <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
        {state.order.map((key, index) => {
          const label = labels.get(key) ?? key;
          return (
            <li key={key} className="flex items-center gap-2 rounded-control border border-line bg-raised px-3 py-1.5">
              <label className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-3 text-sm text-fg [@media(pointer:coarse)]:min-h-10">
                <input type="checkbox" className={checkboxClass} checked={state.checked.has(key)} onChange={() => toggle(key)} />
                <span className="min-w-0 break-words">{label}</span>
              </label>
              <Button
                type="button" variant="ghost" size="icon-sm"
                disabled={index === 0} onClick={() => move(key, -1)}
                aria-label={t('export.columns.moveUp', { column: label })}
              >
                <ArrowUp aria-hidden />
              </Button>
              <Button
                type="button" variant="ghost" size="icon-sm"
                disabled={index === state.order.length - 1} onClick={() => move(key, 1)}
                aria-label={t('export.columns.moveDown', { column: label })}
              >
                <ArrowDown aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface ExportColumnsDialogProps {
  sheets: PickerSheet[];
  onCancel: () => void;
  onConfirm: (choices: SheetChoice[]) => void;
}

/**
 * The one chooser every generic list export opens first. Mounted per request
 * (the provider gives it a fresh `key`), so its state starts from the remembered
 * choice each time and never carries one table's ticks into another.
 */
export function ExportColumnsDialog({ sheets, onCancel, onConfirm }: ExportColumnsDialogProps) {
  const { t } = useTranslation();
  const [states, setStates] = useState<SheetState[]>(() => sheets.map(initialState));
  const empties = sheets.filter((_, i) => validateSelection(selectedOf(states[i])) === 'empty');
  const many = sheets.length > 1;

  const confirm = () => {
    if (empties.length > 0) return;
    onConfirm(sheets.map((sheet, i) => ({
      tableId: sheet.tableId,
      selected: selectedOf(states[i]),
      available: sheet.options.columns.map(col => col.key),
    })));
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('export.columns.title')}</DialogTitle>
          <DialogDescription>{t('export.columns.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[55dvh] grid-cols-1 gap-5 overflow-y-auto pr-1">
          {sheets.map((sheet, i) => (
            <SheetList
              key={sheet.tableId}
              sheet={sheet}
              state={states[i]}
              heading={many ? sheet.options.sheetTitle : null}
              onChange={next => setStates(prev => prev.map((s, j) => (j === i ? next : s)))}
            />
          ))}
        </div>
        {empties.length > 0 && (
          <Alert tone="critical">
            {many
              ? t('export.columns.emptySheet', { sheet: empties.map(s => s.options.sheetTitle).join(', ') })
              : t('export.columns.empty')}
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button type="button" onClick={confirm} disabled={empties.length > 0}>{t('export.columns.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
