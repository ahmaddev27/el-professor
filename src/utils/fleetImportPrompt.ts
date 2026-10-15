/**
 * Whether the Overview should invite a company to import its fleet.
 *
 * The prompt is advice, and advice built on a guess is worse than none: "you
 * have no drivers" is a claim, so a count that is still loading or whose read
 * failed never produces it. A user the import would refuse (the RPCs ask
 * `is_company_admin()`) is not invited either.
 */
export type CountRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; count: number };

export interface ImportPromptInput {
  mayImport: boolean;
  drivers: CountRead;
  vehicles: CountRead;
}

export function shouldShowImportPrompt({ mayImport, drivers, vehicles }: ImportPromptInput): boolean {
  if (!mayImport) return false;

  if (drivers.status !== 'ok' || vehicles.status !== 'ok') return false;
  return drivers.count === 0 && vehicles.count === 0;
}
