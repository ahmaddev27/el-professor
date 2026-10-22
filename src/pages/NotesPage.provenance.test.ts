import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonsLabelled, buttonsWithIcon, press, settle, textOf } from '../test-utils/tree';
import { callsOf, type FakeCall } from '../test-utils/fakeSupabase';

/**
 * Notizen: what a note says about itself.
 *
 * The screen's half of 20261022150000. A save sends the provenance fields a
 * person filled in or changed and none it did not, because the database logs
 * every change and takes a verification back for some of them; a review is asked
 * for and never stamped here; a document is stored before its key and taken back
 * when the key is refused; and a note that nobody has reviewed does not read as a
 * proven one.
 */

const world = vi.hoisted(() => ({
  notes: [] as Record<string, unknown>[],
  mayEdit: true,
  showToast: vi.fn(),
  /** What an UPDATE answers: rows touched, or an error. */
  updateError: null as null | { message: string },
  touches: true,
  storage: [] as string[],
  fake: null as null | ReturnType<typeof import('../test-utils/fakeSupabase').createFakeSupabase>,
  translation: {
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}(${JSON.stringify(vars)})` : key),
    tPlural: (keys: { one: string; other: string }, count: number) => (count === 1 ? keys.one : keys.other),
  },
}));

const baseNote = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'n1', driver_id: 'd1', note_date: '2026-10-13T08:00:37.000Z', note_text: 'Hinweis',
  created_at: '2026-10-13T08:00:37.000Z', note_type: 'general', note_planning_behavior: 'neutral',
  is_full_day: true, start_time: null, end_time: null, start_date: '2026-10-13', end_date: '2026-10-13',
  car_id: null, drivers: { name: 'Anna' }, cars: null, created_by: 'u1',
  entry_source: 'manual', received_at: '2026-10-13T08:00:37.000Z', verification_status: 'unverified',
  occurred_at: null, reported_at: null, evidence_path: null, latitude: null, longitude: null,
  location_accuracy_m: null, change_log: [], ...patch,
});

vi.mock('../lib/supabase', async () => {
  const { createFakeSupabase } = await import('../test-utils/fakeSupabase');
  world.fake = createFakeSupabase((call: FakeCall) => {
    if (call.op === 'update') {
      if (world.updateError) return { data: null, error: world.updateError };
      return { data: world.touches ? [{ id: 'n1' }] : [], error: null };
    }
    if (call.op === 'delete') return { data: [{ id: 'n1' }], error: null };
    const rows: Record<string, unknown[]> = {
      driver_notes: world.notes,
      drivers: [{ id: 'd1', name: 'Anna' }],
      user_profiles: [{ user_id: 'u1', full_name: 'Berta Beispiel', email: 'b@example.com' }],
    };
    return { data: rows[call.table] ?? [], error: null };
  });
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, _body: unknown, options: { contentType: string }) => {
        world.storage.push(`upload:${bucket}:${path}:${options.contentType}`);
        return { error: null };
      },
      remove: async (paths: string[]) => {
        world.storage.push(`remove:${bucket}:${paths.join(',')}`);
        return { error: null };
      },
      createSignedUrl: async () => ({ data: null, error: { message: 'no' } }),
    }),
  };
  return { supabase: { ...world.fake.client, storage } };
});
vi.mock('../hooks/useCompanyScope', () => ({ useCompanyScope: () => ({ can: () => world.mayEdit }) }));
vi.mock('../contexts/SuperAdminContext', () => ({ useSuperAdmin: () => ({ effectiveCompanyId: 'company-1' }) }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ showToast: world.showToast }) }));
vi.mock('../contexts/LanguageContext', () => ({ useTranslation: () => world.translation }));
vi.mock('../hooks/usePartnerCatchUp', () => ({
  usePartnerCatchUp: () => ({ catchUp: async () => false, fetching: false, available: false }),
}));

const eventTarget = () => ({ addEventListener: () => {}, removeEventListener: () => {} });
Object.assign(globalThis, { window: eventTarget(), document: { ...eventTarget(), visibilityState: 'visible' } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { NotesPage } = await import('./NotesPage');

const PROVENANCE_KEYS = [
  'occurred_at', 'reported_at', 'latitude', 'longitude', 'location_accuracy_m',
  'evidence_path', 'verification_status', 'rejected_reason', 'entry_source', 'received_at', 'change_log',
];

async function mount(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(createElement(NotesPage)); });
  await settle();
  return tree;
}

async function openForEdit(note: Record<string, unknown>): Promise<ReactTestRenderer> {
  world.notes = [note];
  const tree = await mount();
  await press(buttonsWithIcon(tree, 'credit-card')[0]);
  return tree;
}

async function openNew(): Promise<ReactTestRenderer> {
  world.notes = [];
  const tree = await mount();
  await press(buttonsWithIcon(tree, 'plus')[0]);
  return tree;
}

const field = (tree: ReactTestRenderer, id: string): ReactTestInstance[] =>
  tree.root.findAll(n => (n.type === 'input' || n.type === 'textarea') && n.props.id === id);

async function typeInto(tree: ReactTestRenderer, id: string, value: string): Promise<void> {
  const found = field(tree, id);
  expect(found, id).toHaveLength(1);
  await act(async () => { found[0].props.onChange({ target: { value } }); });
  await settle();
}

async function pickDriver(tree: ReactTestRenderer): Promise<void> {
  // The page's own driver filter also lists d1; the one to pick is the form's.
  const form = tree.root.findAll(n => n.type === 'form')[0];
  const select = form.findAll(n => n.type === 'select'
    && n.findAll(o => o.type === 'option' && o.props.value === 'd1').length > 0)[0];
  await act(async () => { select.props.onChange({ target: { value: 'd1' } }); });
  await settle();
}

async function submit(tree: ReactTestRenderer): Promise<void> {
  const form = tree.root.findAll(n => n.type === 'form')[0];
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  await settle();
}

const updates = () => callsOf(world.fake!.calls, 'driver_notes', 'update');
const inserts = () => callsOf(world.fake!.calls, 'driver_notes', 'insert');
const sentUpdate = () => updates()[0]?.payload as Record<string, unknown> | undefined;
const sentInsert = () => (inserts()[0]?.payload as Record<string, unknown>[] | undefined)?.[0];
const toasts = () => world.showToast.mock.calls.map(c => `${c[0]}:${c[1]}`);
const provenanceKeysIn = (payload: Record<string, unknown> | undefined): string[] =>
  Object.keys(payload ?? {}).filter(key => PROVENANCE_KEYS.includes(key));

beforeEach(() => {
  world.mayEdit = true;
  world.updateError = null;
  world.touches = true;
  world.storage.length = 0;
  world.showToast.mockReset();
  world.fake!.calls.length = 0;
});

describe('a save sends only the provenance a person filled in or changed', () => {
  it('a new note that uses none of it sends none of it', async () => {
    const tree = await openNew();
    await pickDriver(tree);
    await submit(tree);

    expect(inserts()).toHaveLength(1);
    expect(provenanceKeysIn(sentInsert())).toEqual([]);
  });

  it('a new note with an occurrence sends that, as an instant with an offset, and nothing else', async () => {
    const tree = await openNew();
    await pickDriver(tree);
    await typeInto(tree, 'note-occurred-at', '2026-09-01T14:03');
    await submit(tree);

    expect(provenanceKeysIn(sentInsert())).toEqual(['occurred_at']);
    expect(String(sentInsert()!.occurred_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('an edit that touches none of it sends none of it, however the stored values would round', async () => {
    const tree = await openForEdit(baseNote({
      occurred_at: '2026-09-01T12:03:37.123+00:00', reported_at: '2026-10-02T07:00:00+00:00',
      latitude: 51.123456789, longitude: 7.4, location_accuracy_m: 12.5,
    }));
    await submit(tree);

    expect(updates()).toHaveLength(1);
    expect(provenanceKeysIn(sentUpdate())).toEqual([]);
  });

  it('an edit that changes one field sends that field alone', async () => {
    const tree = await openForEdit(baseNote({ occurred_at: '2026-09-01T12:03:00+00:00' }));
    await typeInto(tree, 'note-reported-at', '2026-10-02T09:00');
    await submit(tree);

    expect(provenanceKeysIn(sentUpdate())).toEqual(['reported_at']);
  });

  it('a position is sent as a unit, German decimals read', async () => {
    const tree = await openNew();
    await pickDriver(tree);
    await typeInto(tree, 'note-latitude', '51,5');
    await typeInto(tree, 'note-longitude', '7,25');
    await typeInto(tree, 'note-accuracy', '12');
    await submit(tree);

    expect(sentInsert()).toMatchObject({ latitude: 51.5, longitude: 7.25, location_accuracy_m: 12 });
  });
});

describe('a problem is found before the database is asked', () => {
  it('an event dated after its report is not sent', async () => {
    const tree = await openNew();
    await pickDriver(tree);
    await typeInto(tree, 'note-occurred-at', '2026-10-02T09:00');
    await typeInto(tree, 'note-reported-at', '2026-09-01T14:03');
    await submit(tree);

    expect(toasts()).toEqual(['error:notes.prov.err.eventOrder']);
    expect(inserts()).toHaveLength(0);
  });

  it('half a position is not sent', async () => {
    const tree = await openNew();
    await pickDriver(tree);
    await typeInto(tree, 'note-latitude', '51,5');
    await submit(tree);

    expect(toasts()).toEqual(['error:notes.prov.err.position']);
    expect(inserts()).toHaveLength(0);
  });

  it('a refusal by the database is told in a sentence, by the constraint\'s name', async () => {
    world.updateError = { message: 'new row violates check constraint "driver_notes_location_range"' };
    const tree = await openForEdit(baseNote());
    await submit(tree);

    expect(toasts()).toEqual(['error:notes.prov.err.position']);
  });
});

describe('the section', () => {
  it('is offered for an incident and not for an absence, whose window is the fact', async () => {
    const incident = await openForEdit(baseNote({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan', car_id: 'c1' }));
    expect(field(incident, 'note-occurred-at')).toHaveLength(1);

    const absence = await openForEdit(baseNote({ note_type: 'sick', note_planning_behavior: 'exclude_from_plan' }));
    expect(field(absence, 'note-occurred-at')).toHaveLength(0);
  });

  it('says a new note can be reviewed and given a document after its first save, and offers neither yet', async () => {
    const tree = await openNew();
    expect(textOf(tree)).toContain('notes.prov.saveFirst');
    expect(textOf(tree)).not.toContain('notes.prov.review.title');
  });
});

describe('the review', () => {
  it('asks for a verification and sends the status alone: who and when are the database\'s', async () => {
    const tree = await openForEdit(baseNote());
    await press(buttonsLabelled(tree, 'notes.prov.action.verify')[0]);

    expect(sentUpdate()).toEqual({ verification_status: 'verified' });
    expect(toasts()).toEqual(['success:notes.prov.saved']);
  });

  it('asks for a reason before a rejection can be saved, and sends it trimmed', async () => {
    const tree = await openForEdit(baseNote());
    await press(buttonsLabelled(tree, 'notes.prov.action.reject')[0]);

    const confirm = () => buttonsLabelled(tree, 'notes.prov.action.confirmReject')[0];
    expect(confirm().props.disabled).toBe(true);

    await typeInto(tree, 'note-reject-reason', '  Datum stimmt nicht ');
    expect(confirm().props.disabled).toBe(false);
    await press(confirm());

    expect(sentUpdate()).toEqual({ verification_status: 'rejected', rejected_reason: 'Datum stimmt nicht' });
  });

  it('reports a refusal, not a success, for a role the page gate hides the row from', async () => {
    world.touches = false;
    const tree = await openForEdit(baseNote());
    await press(buttonsLabelled(tree, 'notes.prov.action.verify')[0]);

    expect(toasts()).toEqual(['error:common.writeRefused']);
  });

  it('is shown to a role that may not edit, with no way to decide', async () => {
    world.mayEdit = false;
    world.notes = [baseNote({ verification_status: 'verified', reviewed_by: 'u1', reviewed_at: '2026-10-14T10:00:00+00:00' })];
    const tree = await mount();
    expect(textOf(tree)).toContain('notes.prov.status.verified');
    expect(buttonsWithIcon(tree, 'credit-card')).toHaveLength(0);
  });

  it('names the reviewer from the company\'s people, and an unknown one as unknown', async () => {
    const named = await openForEdit(baseNote({ verification_status: 'verified', reviewed_by: 'u1', reviewed_at: '2026-10-14T10:00:00+00:00' }));
    expect(textOf(named)).toContain('Berta Beispiel');

    const unknown = await openForEdit(baseNote({ verification_status: 'verified', reviewed_by: 'u-gone', reviewed_at: '2026-10-14T10:00:00+00:00' }));
    expect(textOf(unknown)).toContain('notes.prov.unknownPerson');
  });

  it('warns, before the save, that a change to what was reviewed takes the review back', async () => {
    const tree = await openForEdit(baseNote({ verification_status: 'verified', reviewed_by: 'u1', reviewed_at: '2026-10-14T10:00:00+00:00' }));
    expect(textOf(tree)).not.toContain('notes.prov.review.resetWarning');

    await typeInto(tree, 'note-occurred-at', '2026-10-13T08:00');
    expect(textOf(tree)).toContain('notes.prov.review.resetWarning');
  });

  it('does not warn about a note nobody has reviewed, but tells the person to save first', async () => {
    const tree = await openForEdit(baseNote());
    await typeInto(tree, 'note-occurred-at', '2026-10-13T08:00');
    expect(textOf(tree)).not.toContain('notes.prov.review.resetWarning');
    expect(textOf(tree)).toContain('notes.prov.review.saveBeforeReview');
  });

  it('will not review a version nobody saved: with unsaved changes to what a review covers, deciding waits', async () => {
    const tree = await openForEdit(baseNote());
    expect(buttonsLabelled(tree, 'notes.prov.action.verify')[0].props.disabled).toBe(false);

    await typeInto(tree, 'note-occurred-at', '2026-10-13T08:00');
    expect(buttonsLabelled(tree, 'notes.prov.action.verify')[0].props.disabled).toBe(true);
    expect(buttonsLabelled(tree, 'notes.prov.action.reject')[0].props.disabled).toBe(true);

    await press(buttonsLabelled(tree, 'notes.prov.action.verify')[0]);
    expect(updates()).toHaveLength(0);
  });

  it('still lets a decision be taken back while changes are open: saving them would do it anyway', async () => {
    const tree = await openForEdit(baseNote({ verification_status: 'verified', reviewed_by: 'u1', reviewed_at: '2026-10-14T10:00:00+00:00' }));
    await typeInto(tree, 'note-occurred-at', '2026-10-13T08:00');
    expect(buttonsLabelled(tree, 'notes.prov.action.retract')[0].props.disabled).toBe(false);
  });
});

describe('the list does not let a typed note read as a proven one', () => {
  it('shows a review and a rejection', async () => {
    world.notes = [
      baseNote({ id: 'a', verification_status: 'verified' }),
      baseNote({ id: 'b', verification_status: 'rejected', rejected_reason: 'x' }),
    ];
    const tree = await mount();
    expect(textOf(tree)).toContain('notes.prov.status.verified');
    expect(textOf(tree)).toContain('notes.prov.status.rejected');
  });

  it('says an unreviewed incident is unreviewed, and says nothing for an ordinary note', async () => {
    world.notes = [baseNote({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan', car_id: 'c1' })];
    expect(textOf(await mount())).toContain('notes.prov.status.unverified');

    world.notes = [baseNote()];
    expect(textOf(await mount())).not.toContain('notes.prov.status.unverified');
  });

  it('shows that a document is attached, and the moment the event happened', async () => {
    world.notes = [baseNote({
      evidence_path: 'company-1/driver-notes/n1/f.pdf', occurred_at: '2026-09-01T12:03:00+00:00',
    })];
    const text = textOf(await mount());
    expect(text).toContain('notes.prov.chip.evidence');
    expect(text).toContain('notes.prov.occurredLine');
  });

  it('reads a note from before the migration, which has none of these fields, as an ordinary one', async () => {
    const legacy = baseNote();
    for (const key of PROVENANCE_KEYS) delete legacy[key];
    world.notes = [legacy];
    const tree = await mount();
    expect(textOf(tree)).toContain('Hinweis');
    expect(textOf(tree)).not.toContain('notes.prov.status.');
  });
});

describe('a document', () => {
  const picked = { name: 'Bescheid.pdf', type: 'application/pdf', size: 4096 };
  const fileInput = (tree: ReactTestRenderer) => field(tree, 'note-evidence-file')[0];

  it('is stored first and pointed at second', async () => {
    const tree = await openForEdit(baseNote({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan', car_id: 'c1' }));
    await act(async () => { fileInput(tree).props.onChange({ target: { files: [picked], value: 'x' } }); });
    await settle();

    expect(world.storage).toHaveLength(1);
    expect(world.storage[0]).toMatch(/^upload:documents:company-1\/driver-notes\/n1\/[0-9a-f-]{36}\.pdf:application\/pdf$/);
    expect(sentUpdate()).toEqual({ evidence_path: world.storage[0].split(':')[2] });
    expect(toasts()).toEqual(['success:notes.prov.evidence.added']);
  });

  it('is taken back when the key is refused', async () => {
    world.touches = false;
    const tree = await openForEdit(baseNote({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan', car_id: 'c1' }));
    await act(async () => { fileInput(tree).props.onChange({ target: { files: [picked], value: 'x' } }); });
    await settle();

    expect(world.storage.map(step => step.split(':')[0])).toEqual(['upload', 'remove']);
    expect(toasts()).toEqual(['error:common.writeRefused']);
  });

  it('is not stored at all when it is the wrong kind of file', async () => {
    const tree = await openForEdit(baseNote({ note_type: 'blitzer', note_planning_behavior: 'must_include_in_plan', car_id: 'c1' }));
    await act(async () => {
      fileInput(tree).props.onChange({ target: { files: [{ name: 'x.svg', type: 'image/svg+xml', size: 10 }], value: 'x' } });
    });
    await settle();

    expect(world.storage).toEqual([]);
    expect(updates()).toHaveLength(0);
    expect(toasts()).toEqual(['error:notes.prov.err.evidenceType']);
  });

  it('is not offered on a sick note, whose window is the fact', async () => {
    const tree = await openForEdit(baseNote({ note_type: 'sick', note_planning_behavior: 'exclude_from_plan' }));
    expect(fileInput(tree)).toBeUndefined();
  });

  it('goes with the note when the note is deleted', async () => {
    world.notes = [baseNote({ evidence_path: 'company-1/driver-notes/n1/f.pdf' })];
    const tree = await mount();
    await press(buttonsWithIcon(tree, 'trash')[0]);
    await press(buttonsLabelled(tree, 'common.delete')[0]);

    expect(world.storage).toEqual(['remove:documents:company-1/driver-notes/n1/f.pdf']);
  });
});
