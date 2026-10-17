import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STAY_SOURCES, STAY_STATUSES } from '@/lib/stays/types'
import { STAY_FILTERS } from '@/lib/stays/filters'

// Every message key the Stays screens and API use must exist in the "Stays"
// namespace. A missing key renders as a raw key path in the UI, which is easy
// to miss in review, so this scans the source for t('...') calls.

const ROOT = process.cwd()
const en = JSON.parse(readFileSync(join(ROOT, 'messages/en.json'), 'utf8'))

function has(path: string): boolean {
  let node: unknown = en.Stays
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in (node as object))) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return files(p, ext)
    return ext.test(e.name) && !e.name.includes('.test.') ? [p] : []
  })
}

const SOURCES = [
  ...files(join(ROOT, 'src/components/stays'), /\.tsx?$/),
  join(ROOT, 'src/app/(dashboard)/stays/page.tsx'),
  ...files(join(ROOT, 'src/app/api/stays'), /\.ts$/),
  join(ROOT, 'src/lib/stays/server.ts'),
]

describe('Stays message keys', () => {
  it('every literal t("key") exists in messages/en.json', () => {
    const missing: string[] = []
    for (const file of SOURCES) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
        if (!has(m[1])) missing.push(`${file.replace(ROOT, '')}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every dynamic key family is fully covered', () => {
    const families: Array<[string, readonly string[]]> = [
      ['status', STAY_STATUSES],
      ['source', STAY_SOURCES],
      ['filters', STAY_FILTERS],
      ['idStatus', ['none', 'pending', 'verified', 'rejected']],
      ['formStatus', ['pending', 'submitted']],
      ['automation.reason', ['cancelled', 'sample', 'no_mobile', 'paused', 'closed']],
    ]
    const missing = families.flatMap(([prefix, values]) =>
      values.filter((v) => !has(`${prefix}.${v}`)).map((v) => `${prefix}.${v}`),
    )
    expect(missing).toEqual([])
  })

  it('every validation error key has a message', () => {
    const src = readFileSync(join(ROOT, 'src/lib/stays/validate.ts'), 'utf8')
    const type = src.match(/export type StayErrorKey =([^]*?)\n\nexport/)?.[1] ?? ''
    const keys = [...type.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(5)
    expect(keys.filter((k) => !has(`errors.${k}`))).toEqual([])
  })
})

// ---- GuestForm (public registration page + its API) -----------------------

function hasGf(path: string): boolean {
  let node: unknown = en.GuestForm
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in (node as object))) return false
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

describe('GuestForm message keys', () => {
  const GF_SOURCES = [
    ...files(join(ROOT, 'src/components/guest-form'), /\.tsx?$/),
    ...files(join(ROOT, 'src/app/api/public/stay'), /\.ts$/),
    join(ROOT, 'src/lib/stays/public-form.ts'),
  ]

  it('every literal t("key") exists', () => {
    const missing: string[] = []
    for (const file of GF_SOURCES) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
        if (!hasGf(m[1])) missing.push(`${file.replace(ROOT, '')}: ${m[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('validation, submit and file error families are covered', () => {
    const src = readFileSync(join(ROOT, 'src/lib/stays/guest-form.ts'), 'utf8')
    const type = src.match(/export type GuestFormErrorKey =([^]*?)\n\n/)?.[1] ?? ''
    const keys = [...type.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(10)
    const pub = readFileSync(join(ROOT, 'src/lib/stays/public-form.ts'), 'utf8')
    const mapped = [...pub.matchAll(/key: '([A-Za-z]+)'/g)].map((m) => m[1])
    const missing = [
      ...keys.map((k) => `errors.${k}`),
      ...mapped.map((k) => `errors.${k}`),
      ...['empty', 'tooLarge', 'unsupportedType'].map((k) => `errors.file_${k}`),
      ...['pdfTooLarge', 'unreadable', 'unsupported'].map((k) => `capture.${k}`),
      ...['aadhaar', 'passport', 'driving_licence', 'voter_id', 'other'].map((k) => `idTypes.${k}`),
      ...['leisure', 'business', 'family', 'event', 'other'].map((k) => `purposes.${k}`),
    ].filter((p) => !hasGf(p))
    expect(missing).toEqual([])
  })
})
