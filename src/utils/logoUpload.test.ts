/**
 * The company logo upload must not accept an SVG, and its size limit must be the
 * bucket's.
 *
 * **Why SVG is the one that matters.** An SVG is a document, not a picture:
 * served inline with `Content-Type: image/svg+xml` it executes whatever script it
 * carries. `company-logos` is public — `CompanySettingsContext` builds every logo
 * URL with `getPublicUrl` — and it is served from the API origin. Uploading is
 * gated on `is_company_admin()`, so the type list in `SettingsPage` was the only
 * thing between a company administrator and a script running on
 * `api.elprofessor.eu`.
 *
 * Measured on production on 28.09.2026: **7 objects, two of them
 * `image/svg+xml`**, belonging to two different companies, the largest object
 * 233,308 bytes. Those two stay — they are customers' logos and removing them
 * blanks a logo somebody uploaded. `allowed_mime_types` gates uploads only, so
 * this change stops the next one and leaves the two to the owner's decision,
 * which is written up in HANDOFF.md.
 *
 * The bound, stated as narrowly as it was established: the app stores its
 * Supabase session in the *app* origin's localStorage, so a script on the API
 * origin does not read it simply by being there. What it certainly gets is
 * execution on a trusted domain. Whether that can be carried further was not
 * established — and is not the reason for the change.
 *
 * This is a source-level test. The upload handler is a closure inside a page that
 * needs the whole provider stack plus a Supabase client to render, and what has to
 * hold is a property of two literals — the accepted types and the size bound —
 * which must agree with `20260928100000_storage_bucket_limits.sql`. A render test
 * would assert the same two literals through three layers of mocks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const page = readFileSync(join(process.cwd(), 'src', 'pages', 'SettingsPage.tsx'), 'utf8')
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260928100000_storage_bucket_limits.sql'),
  'utf8',
)

/** The page without its comments, so a comment naming the old type cannot pass a test. */
const code = page
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

const validTypes = /const validTypes = \[([^\]]*)\]/.exec(code)?.[1] ?? ''

describe('the logo upload’s accepted types', () => {
  it('does not accept SVG', () => {
    expect(validTypes).not.toContain('svg')
  })

  it('still accepts the raster formats a logo actually comes in', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(validTypes).toContain(type)
    }
  })

  it('NEGATIVE CONTROL: the list that shipped did accept it', () => {
    const shipped = "['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']"
    expect(shipped).toContain('image/svg+xml')
    expect(validTypes).not.toBe(shipped)
  })
})

describe('the browser’s limits agree with the bucket’s', () => {
  it('refuses the same size the bucket refuses', () => {
    // 2 MiB in both, so a file the bucket would reject is refused with a sentence
    // somebody wrote rather than a storage error nobody did.
    expect(code).toContain('file.size > 2 * 1024 * 1024')
    expect(migration).toContain('2097152')
    expect(2 * 1024 * 1024).toBe(2097152)
  })

  it('offers no type the bucket would reject', () => {
    const allowed = /allowed_mime_types = ARRAY\[([^\]]*)\]/.exec(migration)?.[1] ?? ''
    expect(allowed).not.toContain('svg')
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(allowed).toContain(type)
    }
    // `image/jpg` is not a real media type; browsers report a .jpg as image/jpeg.
    // It stays in the page's list as a belt-and-braces accept and is correctly
    // absent from the bucket's, so it is the one entry that may differ.
    const pageTypes = validTypes.match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? []
    for (const type of pageTypes) {
      if (type === 'image/jpg') continue
      expect(allowed).toContain(type)
    }
  })
})

describe('the two buckets the migration touches', () => {
  it('closes document-templates and leaves company-logos open', () => {
    // Closing company-logos would blank every logo in the app and in the
    // Mietwagenauftrag, silently: getPublicUrl keeps answering a URL that 400s.
    expect(migration).toMatch(/SET public = false\s*\n\s*WHERE id = 'document-templates'/)
    expect(migration).not.toMatch(/public = false[\s\S]{0,80}company-logos/)
  })

  it('touches no object, only the two buckets', () => {
    // A migration that deletes a customer's file is the one mistake here that
    // nobody would notice until a screen went blank.
    expect(migration).not.toMatch(/DELETE\s+FROM\s+storage\.objects/i)
    expect(migration).not.toMatch(/UPDATE\s+storage\.objects/i)
  })
})
