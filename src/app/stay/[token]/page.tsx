import type { Metadata } from 'next'
import { GuestForm } from '@/components/guest-form/guest-form'

// Public guest registration page (PDR 6). No login: the token in the URL is
// the credential. Kept out of search results, and the Referer header is
// dropped so the token never leaks to another site.
export const metadata: Metadata = {
  title: { absolute: 'Guest registration' },
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
}

export default async function StayFormPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return <GuestForm token={token} />
}
