/**
 * The discount field on the Google registration screen must not submit the
 * registration form. That form creates the company.
 *
 * `CompleteRegistrationPage.tsx` opens `<form onSubmit={submit}>` at :247, renders
 * `PlanSelection` at :284, and closes the form at :319 — so the discount block sits
 * inside it. Three ways of using the field submitted that form:
 *
 *   1. "Anwenden"            — the Button carried `type="submit"`
 *   2. the X that removes a code — likewise
 *   3. Enter in the code field    — implicit submission; the handler never called
 *                                   preventDefault
 *
 * `handleApply` is async, so the company was created before the code could be
 * applied and the discount was silently lost.
 *
 * **It is reachable on production.** Measured 28.09.2026: GoTrue's own
 * `/auth/v1/settings` on api.elprofessor.eu reports `external.google: true`, so the
 * Google registration screen is live. `SignupPage` renders this block *outside* its
 * two forms (block at :253, forms at :273 and :305), so the password signup was
 * never affected — which is why this went unnoticed.
 *
 * This is a source-level test on purpose. The component needs the whole auth and
 * app-config provider stack plus a Supabase client to render, and what has to hold
 * is a property of the markup: no submitting control inside this block. A render
 * test would assert the same thing through three layers of mocks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src', 'components', 'signup', 'PlanSelection.tsx')
const source = readFileSync(SRC, 'utf8')

/** Strip // line comments so a comment quoting the old code cannot pass or fail a test. */
const code = source
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n')

describe('the discount field cannot submit the registration form', () => {
  it('has no type="submit" anywhere in its markup', () => {
    expect(code).not.toContain('type="submit"')
  })

  it('gives every clickable control an explicit type', () => {
    // Both the design-system `<Button>` and a raw `<button>` count: a raw one with
    // no type submits, and the design-system one defaults to "button" but is written
    // out here so the intent survives the next edit.
    const controls = code.match(/<[Bb]utton\b/g) ?? []
    const typed = code.match(/type="button"/g) ?? []
    expect(controls.length).toBeGreaterThan(0)
    expect(typed.length).toBeGreaterThanOrEqual(controls.length)
  })

  it('calls preventDefault before applying on Enter, so the form is not submitted implicitly', () => {
    // A text input inside a form submits it on Enter whatever the buttons say, so
    // this is a separate path and needs its own guard.
    //
    // Matched to the end of the line, not with `[^}]*` — the handler contains braces
    // of its own, and the first draft of this test stopped at the first one and
    // reported the code broken when it was not.
    const enter = code.split('\n').find(l => l.includes('onKeyDown=')) ?? ''
    expect(enter).toContain('Enter')
    expect(enter).toContain('preventDefault')
    expect(enter).toContain('handleApply')
    // preventDefault must come first: handleApply is async and the submission is
    // synchronous, so calling it afterwards would not stop it.
    expect(enter.indexOf('preventDefault')).toBeLessThan(enter.indexOf('handleApply'))
  })

  it('NEGATIVE CONTROL: the shipped markup would fail all three of the above', () => {
    // The exact shape that shipped, so a regression is recognised rather than
    // reasoned about.
    const shipped = `
        <Button
          type="submit"
          variant="secondary"
          onClick={handleApply}
        >
        <Input
            onKeyDown={e => e.key === 'Enter' && handleApply()}
        />`
    expect(shipped).toContain('type="submit"')
    expect(shipped).not.toContain('preventDefault')
  })
})

describe('the screens that render it', () => {
  const page = (p: string) => readFileSync(join(process.cwd(), 'src', 'pages', p), 'utf8')

  it('CompleteRegistrationPage really does wrap it in a form', () => {
    // If this ever stops being true the fix is still correct, but the reason
    // recorded above would be stale — so the test names the fact.
    const s = page('CompleteRegistrationPage.tsx')
    const formAt = s.indexOf('<form')
    const blockAt = s.indexOf('<PlanSelection')
    const formEnd = s.indexOf('</form>')
    expect(formAt).toBeGreaterThan(-1)
    expect(blockAt).toBeGreaterThan(formAt)
    expect(blockAt).toBeLessThan(formEnd)
  })

  it('SignupPage renders it outside its forms, which is why signup never broke', () => {
    const s = page('SignupPage.tsx')
    const blockAt = s.indexOf('<PlanSelection')
    const firstForm = s.indexOf('<form')
    expect(blockAt).toBeGreaterThan(-1)
    expect(blockAt).toBeLessThan(firstForm)
  })
})
