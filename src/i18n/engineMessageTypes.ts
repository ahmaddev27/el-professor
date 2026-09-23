/**
 * The two types an engine needs to name a message key beside its German text.
 *
 * This module imports nothing, on purpose: the engines under `src/utils/` are
 * pure and several are pinned by golden-master snapshots, so they must not
 * reach the dictionaries, the translator or React. They declare a key; the
 * screen resolves it through `./engineMessage`.
 */

/** A key into the dictionaries, as an engine writes it: a plain string. */
export type EngineMessageKey = string;

/** Values for the key's `{placeholder}` slots, already formatted the German way. */
export type EngineMessageVars = Record<string, string | number>;
