/**
 * The delivery path, and the property the owner asked for: when the service is
 * down the user gets a message and NO file, not a file written by something else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { ExportServiceError } from '../lib/exportService';
import { setExportFailureSink, type ExportFailureReport } from '../lib/exportFeedback';

const { triggerDownload, fetchWorkbook, writeFile } = vi.hoisted(() => ({
  triggerDownload: vi.fn(),
  fetchWorkbook: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('./browserDownload', () => ({ triggerDownload }));
vi.mock('../lib/exportService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/exportService')>()),
  fetchWorkbook,
}));
// The negative control: no browser-side writer may be reached on a failure.
vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>();
  return { ...real, writeFile, default: { ...real, writeFile } };
});
vi.mock('./styledWorkbookDownload', () => ({
  downloadStyledWorkbook: () => { throw new Error('the ExcelJS writer must not be reached'); },
  styledWorkbookBlob: () => { throw new Error('the ExcelJS writer must not be reached'); },
}));

import { deliverWorkbook, deliverWorkbookPayload, downloadServiceWorkbook } from './serviceWorkbookDownload';

function workbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, { A1: { t: 's', v: 'x' }, '!ref': 'A1:A1' } as XLSX.WorkSheet, 'S');
  return wb;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('downloadServiceWorkbook', () => {
  beforeEach(() => { triggerDownload.mockClear(); fetchWorkbook.mockReset(); writeFile.mockClear(); });

  it('downloads exactly what the service answered, under the given name', async () => {
    const blob = new Blob(['PK']);
    fetchWorkbook.mockResolvedValue(blob);
    await downloadServiceWorkbook(workbook(), 'belege.xlsx');
    expect(triggerDownload).toHaveBeenCalledWith(blob, 'belege.xlsx');
    expect(fetchWorkbook.mock.calls[0][0]).toEqual({ version: 1, sheets: [{ name: 'S', rows: [['x']] }] });
  });

  it('leaves no partial download when the service fails', async () => {
    fetchWorkbook.mockRejectedValue(new ExportServiceError('unreachable'));
    await expect(downloadServiceWorkbook(workbook(), 'belege.xlsx')).rejects.toBeInstanceOf(ExportServiceError);
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});

describe('deliverWorkbook', () => {
  let reports: ExportFailureReport[];
  let unregister: () => void;

  beforeEach(() => {
    triggerDownload.mockClear(); fetchWorkbook.mockReset(); writeFile.mockClear();
    reports = [];
    unregister = setExportFailureSink(report => reports.push(report));
  });
  afterEach(() => unregister());

  it('a success reports nothing', async () => {
    fetchWorkbook.mockResolvedValue(new Blob(['PK']));
    deliverWorkbook(workbook(), 'a.xlsx');
    await settle();
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([]);
  });

  it('service down: one report, no file, and no other writer is touched', async () => {
    fetchWorkbook.mockRejectedValue(new ExportServiceError('unreachable'));
    deliverWorkbook(workbook(), 'a.xlsx');
    await settle();
    expect(reports).toHaveLength(1);
    expect(reports[0].filename).toBe('a.xlsx');
    expect(reports[0].error).toBeInstanceOf(ExportServiceError);
    expect(triggerDownload).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('a retry runs the delivery again with the same workbook and can succeed', async () => {
    fetchWorkbook.mockRejectedValueOnce(new ExportServiceError('timeout'));
    deliverWorkbook(workbook(), 'a.xlsx');
    await settle();
    expect(reports[0].retry).toBeTypeOf('function');

    fetchWorkbook.mockResolvedValue(new Blob(['PK']));
    reports[0].retry?.();
    await settle();
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(fetchWorkbook.mock.calls[1][0]).toEqual(fetchWorkbook.mock.calls[0][0]);
  });

  it.each(['rejected', 'unauthorized', 'too_large'] as const)('%s offers no retry, because trying again cannot help', async (kind) => {
    fetchWorkbook.mockRejectedValue(new ExportServiceError(kind));
    deliverWorkbook(workbook(), 'a.xlsx');
    await settle();
    expect(reports[0].retry).toBeUndefined();
  });

  it('a workbook the contract cannot carry is reported, with no retry', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, { A1: { t: 'b', v: true }, '!ref': 'A1:A1' } as XLSX.WorkSheet, 'S');
    deliverWorkbook(wb, 'a.xlsx');
    await settle();
    expect(reports).toHaveLength(1);
    expect(reports[0].retry).toBeUndefined();
    expect(fetchWorkbook).not.toHaveBeenCalled();
  });
});

describe('deliverWorkbookPayload', () => {
  const payload = { version: 1 as const, sheets: [{ name: 'S', header: true as const, rows: [['Kennzeichnung'], ['SIMULIERT']] }] };
  let reports: ExportFailureReport[];
  let unregister: () => void;

  beforeEach(() => {
    triggerDownload.mockClear(); fetchWorkbook.mockReset(); writeFile.mockClear();
    reports = [];
    unregister = setExportFailureSink(report => reports.push(report));
  });
  afterEach(() => unregister());

  it('sends the payload as given and downloads what the service answered', async () => {
    const blob = new Blob(['PK']);
    fetchWorkbook.mockResolvedValue(blob);
    deliverWorkbookPayload(payload, 'SIMULIERT_a.xlsx');
    await settle();
    expect(fetchWorkbook.mock.calls[0][0]).toBe(payload);
    expect(triggerDownload).toHaveBeenCalledWith(blob, 'SIMULIERT_a.xlsx');
    expect(reports).toEqual([]);
  });

  it('service down: one report, no file, a retry that sends the same payload', async () => {
    fetchWorkbook.mockRejectedValueOnce(new ExportServiceError('unreachable'));
    deliverWorkbookPayload(payload, 'a.xlsx');
    await settle();
    expect(reports).toHaveLength(1);
    expect(triggerDownload).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    fetchWorkbook.mockResolvedValue(new Blob(['PK']));
    reports[0].retry?.();
    await settle();
    expect(triggerDownload).toHaveBeenCalledTimes(1);
    expect(fetchWorkbook.mock.calls[1][0]).toBe(payload);
  });

  it('a refusal the service will repeat offers no retry', async () => {
    fetchWorkbook.mockRejectedValue(new ExportServiceError('rejected'));
    deliverWorkbookPayload(payload, 'a.xlsx');
    await settle();
    expect(reports[0].retry).toBeUndefined();
  });
});
