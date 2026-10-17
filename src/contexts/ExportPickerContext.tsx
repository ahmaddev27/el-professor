import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExportColumnsDialog, type PickerSheet, type SheetChoice } from '../components/export/ExportColumnsDialog';
import {
  exportSheetsToExcel,
  exportTableToExcel,
  type ExportOptions,
} from '../utils/excelExport';
import { applyColumnSelection, saveRemembered } from '../utils/exportColumnSelection';

/**
 * Opens the column chooser, then writes the file with the chosen columns.
 *
 * `table` is for one sheet (`exportTableToExcel`), `sheets` for several
 * (`exportSheetsToExcel`). The `tableId` is a stable identifier the choice is
 * remembered under, never a label: a label changes with the language.
 */
export interface ColumnPickerExport {
  table: (tableId: string, options: ExportOptions, onWritten?: () => void) => void;
  sheets: (tableId: string, filename: string, options: ExportOptions[], onWritten?: () => void) => void;
}

/** Without a provider (tests, the design harness) the export is written as before. */
const DIRECT: ColumnPickerExport = {
  table: (_id, options, onWritten) => { exportTableToExcel(options); onWritten?.(); },
  sheets: (_id, filename, options, onWritten) => { exportSheetsToExcel(filename, options); onWritten?.(); },
};

const ExportPickerContext = createContext<ColumnPickerExport>(DIRECT);

interface PendingRequest {
  id: number;
  sheets: PickerSheet[];
  write: (chosen: ExportOptions[]) => void;
}

function chosenOptions(sheets: PickerSheet[], choices: SheetChoice[]): ExportOptions[] {
  return sheets.map((sheet, i) => {
    saveRemembered(sheet.tableId, { selected: choices[i].selected, known: choices[i].available });
    return applyColumnSelection(sheet.options, choices[i].selected);
  });
}

export function ExportPickerProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const counter = useRef(0);

  const open = useCallback((sheets: PickerSheet[], write: (chosen: ExportOptions[]) => void) => {
    counter.current += 1;
    setPending({ id: counter.current, sheets, write });
  }, []);

  const api = useMemo<ColumnPickerExport>(() => ({
    table: (tableId, options, onWritten) => open([{ tableId, options }], ([one]) => {
      exportTableToExcel(one);
      onWritten?.();
    }),
    sheets: (tableId, filename, options, onWritten) => open(
      options.map((o, i) => ({ tableId: options.length > 1 ? `${tableId}:${i}` : tableId, options: o })),
      chosen => {
        exportSheetsToExcel(filename, chosen);
        onWritten?.();
      },
    ),
  }), [open]);

  const confirm = (choices: SheetChoice[]) => {
    if (!pending) return;
    const { sheets, write } = pending;
    setPending(null);
    write(chosenOptions(sheets, choices));
  };

  return (
    <ExportPickerContext.Provider value={api}>
      {children}
      {pending && (
        <ExportColumnsDialog key={pending.id} sheets={pending.sheets} onCancel={() => setPending(null)} onConfirm={confirm} />
      )}
    </ExportPickerContext.Provider>
  );
}

/** What a screen calls instead of `exportTableToExcel` / `exportSheetsToExcel`. */
export function useColumnPickerExport(): ColumnPickerExport {
  return useContext(ExportPickerContext);
}
