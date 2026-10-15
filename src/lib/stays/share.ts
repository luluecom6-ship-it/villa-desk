// Helpers for the "Send form on WhatsApp" button on the dashboard.
//
// This opens WhatsApp's click-to-chat with a prefilled message that the staff
// member reviews and sends themselves, so it is a human decision (PDR 4.2:
// manual messages are not gated). Automated sending through the channel send
// function arrives with the scheduler milestone.

export function buildFormMessage(args: { name: string; ref: string; url: string }): string {
  const first = args.name.trim().split(/\s+/)[0] || 'there'
  return [
    `Hello ${first}, thank you for booking Mahinoor Stays.`,
    `Your stay reference is ${args.ref}.`,
    `Please fill in your guest registration before arrival: ${args.url}`,
  ].join('\n')
}

/** https://wa.me/<digits>?text=...  The number must already be digits with country code. */
export function whatsAppLink(phone: string, message: string): string {
  const digits = phone.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}
