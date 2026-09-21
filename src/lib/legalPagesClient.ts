/**
 * `get_legal_pages()` (migration 20260921120000), called. Anonymous and
 * unaudited, like `get_public_config()`: it carries only what the two public
 * pages print.
 */
import { supabase } from './supabase';
import { parseLegalPages, type LegalPages } from './legalPages';

/**
 * The Impressum and the privacy text. Throws when the call fails or the answer
 * is not one, so the page shows that it could not load them — never an empty
 * Impressum that would read as "nothing to declare".
 */
export async function getLegalPages(): Promise<LegalPages> {
  const { data, error } = await supabase.rpc('get_legal_pages');
  if (error) throw new Error(error.message);
  const pages = parseLegalPages(data);
  if (!pages) throw new Error('get_legal_pages: unexpected answer');
  return pages;
}
