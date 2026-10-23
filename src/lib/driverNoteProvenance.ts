/**
 * The writes the Notizen screen makes that are about a note's provenance rather
 * than its content: a review decision, and a document.
 *
 * Every one goes through `updateChecked`: `driver_notes` is gated by the Notizen
 * page right, a refused UPDATE answers 200 with no rows, and a screen that read
 * only `error` would toast success over an unchanged note (lib/writeOutcome.ts).
 *
 * The client is a parameter, so the order of the steps (the file first, the key
 * second, the file taken back if the key is refused) can be tested without a
 * browser. Nothing here decides who the reviewer is or when: the database stamps
 * both from the session and ignores what a request says about them.
 */
import { updateChecked, type WriteClient, type WriteOutcome } from './writeOutcome';
import {
  EVIDENCE_BUCKET,
  checkEvidenceFile,
  evidenceKey,
  type EvidenceFileProblem,
} from '../utils/noteProvenance';

export type ReviewDecision =
  | { status: 'verified' }
  | { status: 'rejected'; reason: string }
  | { status: 'unverified' };

const forNote = (companyId: string, noteId: string) => (q: any) => q.eq('id', noteId).eq('company_id', companyId); // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Verifies, rejects or takes back a decision on one note. A rejection without a
 * reason is not sent: the database refuses it too, and says so by constraint
 * name, but the person should not have to meet that sentence.
 */
export async function decideNote(
  client: WriteClient,
  companyId: string,
  noteId: string,
  decision: ReviewDecision,
): Promise<WriteOutcome | 'reason_missing'> {
  if (decision.status === 'rejected' && decision.reason.trim() === '') return 'reason_missing';
  const values: Record<string, unknown> = { verification_status: decision.status };
  if (decision.status === 'rejected') values.rejected_reason = decision.reason.trim();
  return updateChecked(client, 'driver_notes', values, forNote(companyId, noteId));
}

// ── The document ─────────────────────────────────────────────────────────────

interface StorageResult { error: { message?: string } | null }

/** What the document steps need of the client: its storage, besides the tables a write goes to. */
export interface EvidenceClient extends WriteClient {
  storage: {
    from: (bucket: string) => {
      upload: (path: string, body: unknown, options: { contentType: string; upsert: boolean }) => PromiseLike<StorageResult>;
      remove: (paths: string[]) => PromiseLike<StorageResult>;
      createSignedUrl: (path: string, seconds: number) => PromiseLike<StorageResult & { data: { signedUrl: string } | null }>;
    };
  };
}

export type AttachResult =
  | { ok: true; path: string }
  | { ok: false; problem: EvidenceFileProblem | 'upload' | 'refused' | 'gone' };

export interface EvidenceFile { name: string; type: string; size: number }

export const SIGNED_URL_SECONDS = 60;

/** A key's file taken out of storage, best effort: a stored key that points at nothing is harmless, a file nobody points at is not. */
export async function removeEvidenceFile(client: EvidenceClient, path: string): Promise<void> {
  try {
    await client.storage.from(EVIDENCE_BUCKET).remove([path]);
  } catch {
    // The note is already free of it; there is nothing left to tell the person.
  }
}

/**
 * Stores one file for a saved note and points the note at it.
 *
 * The file goes first and the key second, so a note never points at nothing; and
 * when the key is refused (no right to edit, or the note is gone) the file is
 * taken back, so a refused attachment leaves nothing behind. The name is a fresh
 * uuid: it carries nothing about the person, and cannot collide or overwrite.
 */
export async function attachEvidence(
  client: EvidenceClient,
  args: {
    companyId: string;
    noteId: string;
    file: EvidenceFile & Blob;
    newFileId?: () => string;
  },
): Promise<AttachResult> {
  const check = checkEvidenceFile(args.file);
  if (!check.ok) return { ok: false, problem: check.problem };

  const path = evidenceKey(args.companyId, args.noteId, (args.newFileId ?? (() => crypto.randomUUID()))(), check.ext);
  const stored = await client.storage.from(EVIDENCE_BUCKET).upload(path, args.file, {
    contentType: check.contentType,
    upsert: false,
  });
  if (stored.error) return { ok: false, problem: 'upload' };

  let outcome: WriteOutcome;
  try {
    outcome = await updateChecked(client, 'driver_notes', { evidence_path: path }, forNote(args.companyId, args.noteId));
  } catch (error) {
    await removeEvidenceFile(client, path);
    throw error;
  }
  if (outcome !== 'done') {
    await removeEvidenceFile(client, path);
    return { ok: false, problem: outcome };
  }
  return { ok: true, path };
}

/**
 * Takes a document off a note and out of storage. The key is cleared first, and
 * the file only when that was done: a file whose key could not be cleared stays
 * where the note can still reach it. The log keeps the earlier key, which then
 * points at nothing, by design: the log records that there was one.
 */
export async function detachEvidence(
  client: EvidenceClient,
  companyId: string,
  noteId: string,
  path: string,
): Promise<WriteOutcome> {
  const outcome = await updateChecked(client, 'driver_notes', { evidence_path: null }, forNote(companyId, noteId));
  if (outcome === 'done') await removeEvidenceFile(client, path);
  return outcome;
}

/** A short-lived link to a note's document; null when storage refuses it. */
export async function evidenceUrl(client: EvidenceClient, path: string): Promise<string | null> {
  const { data, error } = await client.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  return error ? null : data?.signedUrl ?? null;
}

/**
 * Opens a document in a new tab. The tab is opened before the link is fetched,
 * because a tab opened after an await counts as a pop-up and is blocked (the
 * Gehaltsquittung does the same). False when no link could be made.
 */
export async function openEvidence(client: EvidenceClient, path: string): Promise<boolean> {
  const tab = window.open('', '_blank');
  const url = await evidenceUrl(client, path);
  if (!url) {
    tab?.close();
    return false;
  }
  if (tab) {
    tab.opener = null;
    tab.location.replace(url);
    return true;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.click();
  return true;
}
