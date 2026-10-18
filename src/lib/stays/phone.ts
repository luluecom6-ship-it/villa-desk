// Phone handling for stays. The PDR rule: numbers are stored as digits with
// the country code (default +91) and matched on that form only.

export const DEFAULT_COUNTRY_CODE = '91'

export interface StayPhoneResult {
  /** Digits with country code, or null when the input was empty. */
  phone: string | null
  /** Set when the input was non-empty but cannot be a valid number. */
  error?: 'invalid_phone'
}

/**
 * Normalise a mobile number typed by staff or sent by an integration.
 *
 *   "+91 98765-43210"  -> "919876543210"
 *   "98765 43210"      -> "919876543210"   (10-digit national number)
 *   "098765 43210"     -> "919876543210"   (trunk 0 removed)
 *   "572657189" + 966  -> "966572657189"   (any length national number gets the chosen code)
 *   "919876543210"     -> "919876543210"   (already has the country code)
 *   "+971 50 123 4567" -> "971501234567"   (explicit + wins over the default)
 *   ""                 -> null             (no number: the stay stays a draft)
 */
export function normalizeStayPhone(
  raw: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): StayPhoneResult {
  const text = (raw ?? '').trim()
  if (!text) return { phone: null }

  let digits = text.replace(/\D/g, '')
  if (!digits) return { phone: null, error: 'invalid_phone' }

  const international = text.startsWith('+') || text.startsWith('00')
  if (text.startsWith('00')) digits = digits.slice(2)

  if (!international) {
    // Remove the national trunk prefix(es), then add the default country
    // code to a bare national number.
    // The chosen country code is always added, except when the number already
    // starts with it and is long enough to be code + number (so "966572657189"
    // is kept but the 9-digit Saudi "572657189" gets 966 in front). Numbers
    // typed with "+" are never touched.
    const national = digits.replace(/^0+/, '')
    const hasCode = national.startsWith(defaultCountryCode) && national.length >= 11
    digits = hasCode ? national : defaultCountryCode + national
  }

  return isValidStayPhone(digits)
    ? { phone: digits }
    : { phone: null, error: 'invalid_phone' }
}

/** Same rule as the database CHECK: 8 to 15 digits, no leading zero. */
export function isValidStayPhone(phone: string): boolean {
  return /^[1-9][0-9]{7,14}$/.test(phone)
}

/** Mask a number for logs and lists: "91XXXXXX3210". Never log full numbers. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  if (phone.length <= 6) return 'X'.repeat(phone.length)
  return phone.slice(0, 2) + 'X'.repeat(phone.length - 6) + phone.slice(-4)
}
