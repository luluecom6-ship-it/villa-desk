import { describe, expect, it } from 'vitest'
import { pickChannel } from './channel'

describe('which channel carries a stay message', () => {
  it('replies go out on the channel the guest wrote to', () => {
    expect(pickChannel({ conversationChannel: 'evolution', propertyDefault: 'meta' })).toBe('evolution')
    expect(pickChannel({ conversationChannel: 'meta', propertyDefault: 'evolution' })).toBe('meta')
  })
  it('a new guest uses the property default; Evolution when nothing is set', () => {
    expect(pickChannel({ conversationChannel: null, propertyDefault: 'meta' })).toBe('meta')
    expect(pickChannel({ conversationChannel: null, propertyDefault: 'evolution' })).toBe('evolution')
    expect(pickChannel({})).toBe('evolution')
  })
})
