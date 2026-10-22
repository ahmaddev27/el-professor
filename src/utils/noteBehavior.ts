/**
 * What a driver note does to a plan.
 *
 * A note takes the driver out of the plan (`exclude_from_plan`: sick, on leave,
 * not available), puts a ride into it (`must_include_in_plan`: a Blitzer, an
 * accident, a breakdown) or does neither (`neutral`). The answer decides the
 * `Abwesenheit` / `Pflichtnotiz` label that the Stundennachweis page prints into
 * the Stundennachweis PDF handed to the Steuerberater, and which badge the notes
 * carousel draws.
 *
 * **The stored column decides, and it always wins.** `note_planning_behavior` is
 * `NOT NULL DEFAULT 'neutral'` with a CHECK on exactly those three values
 * (20260606080729), and the page selects it in both of its reads. `??` falls
 * through on null and undefined only, so `'neutral'` and even `''` are answers:
 * `||` here would turn a note somebody left neutral into a guess from its text.
 *
 * **The text guess is a fallback for a note that carries no behaviour at all,
 * and for a note loaded from the database it is never reached.** The page's
 * `Note.note_planning_behavior` is typed `string | null | undefined`, which is
 * wider than the column it is read from. The fallback is kept exactly as it was
 * because what it feeds is a label on a statutory document: deleting it, like
 * "fixing" it, is a decision about that document and not a tidy-up. It is
 * written down here so nobody has to rediscover that it guards nothing today.
 *
 * **The keyword lists are discriminators, not labels.** They are German
 * fragments matched against the free text an operator typed, so they stay German
 * in both UI languages, are never routed through the dictionary, and are not to
 * be translated, reworded or reordered. Matching is by substring, as it always
 * was, so `frei` also matches `Freitag` and `ausfall` matches `Ausfallzeit`; the
 * absence list is tested first, so a note that matches both lists reads as an
 * absence. `noteBehavior.test.ts` pins all of this.
 *
 * This is one function because `StundennachweisPage` carried the same
 * expression four times, character for character. A fifth copy is how the next
 * keyword gets added to three of them.
 */

/** Text that marks an absence. Tested first. */
export const ABSENCE_KEYWORDS: readonly string[] = [
  'krank', 'urlaub', 'frei', 'nicht verfügbar', 'gesperrt', 'ausfall', 'abwesend',
];

/** Text that marks a ride the plan must contain. Tested second. */
export const MUST_INCLUDE_KEYWORDS: readonly string[] = [
  'blitzer', 'unfall', 'panne', 'kontrolle', 'wartezeit',
];

/** The two fields of a note that decide its behaviour. */
export interface NoteBehaviorSource {
  note_planning_behavior?: string | null;
  note_text: string;
}

function guessBehaviorFromText(noteText: string): 'exclude_from_plan' | 'must_include_in_plan' | null {
  const text = noteText.toLowerCase();
  if (ABSENCE_KEYWORDS.some(keyword => text.includes(keyword))) return 'exclude_from_plan';
  if (MUST_INCLUDE_KEYWORDS.some(keyword => text.includes(keyword))) return 'must_include_in_plan';
  return null;
}

/**
 * The note's planning behaviour: the stored value when there is one, otherwise
 * the guess from its text, otherwise null. A stored value is returned as it is
 * (`'neutral'` included), so callers compare it with the two behaviours they
 * act on and treat everything else as no behaviour.
 */
export function resolveNoteBehavior(note: NoteBehaviorSource): string | null {
  return note.note_planning_behavior ?? guessBehaviorFromText(note.note_text);
}
