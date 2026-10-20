import { describe, expect, it } from 'vitest'
import { checkTemplateBody, DEFAULT_TEMPLATES, renderTemplate, SAMPLE_VALUES } from './templates'
import { MESSAGE_KEYS } from './schedule'

describe('checkTemplateBody', () => {
  it('accepts valid wording and trims it', () => {
    const r = checkTemplateBody('form_link', '  Hi {guest_first_name}, fill {form_url}  ')
    expect(r).toEqual({ ok: true, body: 'Hi {guest_first_name}, fill {form_url}' })
  })
  it('rejects empty, too long, unknown and missing required variables', () => {
    expect(checkTemplateBody('form_link', '   ')).toMatchObject({ ok: false, error: 'empty' })
    expect(checkTemplateBody('form_link', 'x'.repeat(2001))).toMatchObject({ ok: false, error: 'tooLong' })
    expect(checkTemplateBody('form_link', 'Hi {nope} {form_url}')).toMatchObject({ ok: false, error: 'unknownVariable', detail: '{nope}' })
    expect(checkTemplateBody('form_link', 'Hello there')).toMatchObject({ ok: false, error: 'missingVariable', detail: '{form_url}' })
  })
  it('every built-in text passes its own check', () => {
    for (const k of MESSAGE_KEYS) expect(checkTemplateBody(k, DEFAULT_TEMPLATES[k]).ok).toBe(true)
  })
  it('sample values leave no variable unfilled in the built-ins', () => {
    for (const k of MESSAGE_KEYS) expect(renderTemplate(DEFAULT_TEMPLATES[k], SAMPLE_VALUES)).not.toMatch(/\{[a-z_]+\}/)
  })
})
