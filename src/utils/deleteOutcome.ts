/**
 * A DELETE that a policy refuses removes no row and reports no error, so zero
 * rows back has to be read rather than trusted (the pattern of
 * SalaryPeriodsModal's delete). Two causes give zero rows: the policy refused,
 * or someone else already deleted it. Only the first is a refusal, so the row
 * is looked for before the caller is blamed.
 */
export interface DeleteRefusal extends Error {
  code: '42501';
}

export function deleteRefusal(): DeleteRefusal {
  const error = new Error('permission denied: the delete removed no row') as DeleteRefusal;
  error.code = '42501';
  return error;
}

/** Throws `deleteRefusal()` when nothing was removed and the row is still there. */
export async function throwIfDeleteRefused(
  removed: ReadonlyArray<unknown> | null,
  rowStillExists: () => Promise<boolean>,
): Promise<void> {
  if (removed && removed.length > 0) return;
  if (await rowStillExists()) throw deleteRefusal();
}
