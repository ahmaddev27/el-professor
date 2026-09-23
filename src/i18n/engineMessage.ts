/**
 * Engine messages — a stable key beside the German text.
 *
 * The planning, reconciliation and analysis engines under `src/utils/` are pure
 * modules: no React, no context, no `t(...)`. Several of them are pinned by
 * golden-master snapshots, and their German strings reach exports, audit rows
 * and consistency checks as well as the screen. Calling the translator inside
 * them would make payroll output depend on the UI language, so they do not.
 *
 * Instead every user-visible message carries a key **beside** the text it
 * already produced:
 *
 *   { detail: 'Monatslimit 160h überschritten',
 *     messageKey: 'engine.phase3.reject.monthlyMax',
 *     messageVars: { maxHours: 160 } }
 *
 * The German text is unchanged, so every existing consumer, test and snapshot
 * still sees exactly what it saw before. A screen renders the key instead, and
 * falls back to the German text whenever the key is absent or the dictionaries
 * do not know it — which is what keeps a screen working while a key is being
 * added.
 *
 * Naming: an object with one user-visible message uses `messageKey` /
 * `messageVars`. An object with several uses `<field>Key` / `<field>Vars`
 * (`reasonKey`, `actionKey`, `labelKey`), because one pair of names cannot
 * serve two texts.
 *
 * Keys live under the `engine.` namespace in both dictionaries;
 * `src/i18n/engineMessages.test.ts` reads the engines' source and fails the
 * build when one of them is missing from either dictionary.
 */
import { de } from './de';
import type { EngineMessageKey, EngineMessageVars } from './engineMessageTypes';
import type { TranslationKey, TranslationVars } from './index';

export type { EngineMessageKey, EngineMessageVars };

/** The shape every engine message follows: German text plus an optional key. */
export interface EngineMessage {
  /** The German text the engine produced. The fallback, and what the snapshots pin. */
  readonly text: string;
  readonly messageKey?: EngineMessageKey;
  readonly messageVars?: EngineMessageVars;
}

/** The `t` from `useTranslation()`, for helpers that take it as an argument. */
export type TranslateFn = (key: TranslationKey, vars?: TranslationVars) => string;

/** Does the canonical (German) dictionary define this key? */
export const isTranslationKey = (key: string): key is TranslationKey =>
  Object.prototype.hasOwnProperty.call(de, key);

/**
 * A var whose value is itself a dictionary key is translated first, so a
 * message can carry a closed-vocabulary word (a note type, a status) inside a
 * sentence without the engine ever calling the translator. Nothing else can
 * collide: a real value would have to spell an existing key exactly.
 */
const resolveVars = (t: TranslateFn, vars?: EngineMessageVars | null): TranslationVars | undefined => {
  if (!vars) return undefined;
  const out: TranslationVars = {};
  for (const [name, value] of Object.entries(vars)) {
    out[name] = typeof value === 'string' && isTranslationKey(value) ? t(value) : value;
  }
  return out;
};

/**
 * Render an engine message: the translated key when the dictionaries know it,
 * the German text the engine produced otherwise.
 */
export const engineText = (
  t: TranslateFn,
  text: string | null | undefined,
  messageKey?: EngineMessageKey | null,
  messageVars?: EngineMessageVars | null,
): string => {
  if (messageKey && isTranslationKey(messageKey)) {
    return t(messageKey, resolveVars(t, messageVars));
  }
  return text ?? '';
};

/** `engineText` for an object that already carries the three fields together. */
export const engineMessageText = (t: TranslateFn, message: EngineMessage): string =>
  engineText(t, message.text, message.messageKey, message.messageVars);
