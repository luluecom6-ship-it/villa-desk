import { describe, expect, it } from 'vitest'
import { forwardText, maskPhone, parseAgentMessage, splitCode } from './logic'

describe('agent messages', () => {
  it('plain text is a reply to the guest', () => {
    expect(parseAgentMessage('Yes, parking is free')).toEqual({ kind: 'reply', text: 'Yes, parking is free', code: null })
  })
  it('a leading #number picks the chat and is removed from the reply', () => {
    expect(parseAgentMessage('#482 coming now')).toEqual({ kind: 'reply', text: 'coming now', code: 482 })
  })
  it('a # inside the reply stays as typed', () => {
    expect(parseAgentMessage('Room #3 is ready')).toEqual({ kind: 'reply', text: 'Room #3 is ready', code: null })
  })
  it('commands', () => {
    expect(parseAgentMessage('/off')).toEqual({ kind: 'off' })
    expect(parseAgentMessage('/ON')).toEqual({ kind: 'on' })
    expect(parseAgentMessage('/close #120')).toEqual({ kind: 'close', code: 120 })
    expect(parseAgentMessage('/transfer Sara')).toEqual({ kind: 'transfer', to: 'Sara', code: null })
    expect(parseAgentMessage('/transfer #120 Sara')).toEqual({ kind: 'transfer', to: 'Sara', code: 120 })
    expect(parseAgentMessage('/list')).toEqual({ kind: 'list' })
    expect(parseAgentMessage('/info')).toEqual({ kind: 'info', code: null })
    expect(parseAgentMessage('/whatever')).toEqual({ kind: 'help' })
  })
  it('splitCode', () => {
    expect(splitCode('hello #77 there')).toEqual({ code: 77, rest: 'hello  there' })
    expect(splitCode('no code')).toEqual({ code: null, rest: 'no code' })
  })
})

describe('what the agent receives', () => {
  const card = { name: 'Asha Rao', phoneDigits: '966572657189', stayRef: 'MS-2026-001', stayDates: '12 Nov to 14 Nov' }
  it('the first message carries the guest, the stay and how to answer; the number is masked', () => {
    const t = forwardText({ code: 482, card, body: 'Is parking free?', intro: true })
    expect(t).toContain('#482')
    expect(t).toContain('Asha Rao')
    expect(t).toContain('MS-2026-001')
    expect(t).toContain('“Is parking free?”')
    expect(t).not.toContain('966572657189')
    expect(t).toContain('Swipe-reply')
  })
  it('later messages are short', () => {
    expect(forwardText({ code: 482, card, body: 'Hello?', intro: false })).toBe('*#482 Asha Rao:* “Hello?”')
  })
  it('says when the chat was moved from someone who did not answer', () => {
    expect(forwardText({ code: 1, card, body: 'x', intro: true, movedFrom: 'Ravi' })).toContain('Moved from Ravi')
  })
  it('masks numbers', () => {
    expect(maskPhone('966572657189')).toBe('9665•••••189')
  })
})
