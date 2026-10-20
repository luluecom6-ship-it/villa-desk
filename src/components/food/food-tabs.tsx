import Link from 'next/link'
import { UtensilsCrossed } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Orders and Menu are two pages of the Food area; this is the switch at the top of both. */
export function FoodTabs({ active }: { active: 'orders' | 'menu' }) {
  const tab = (href: string, label: string, on: boolean) => (
    <Link
      href={href}
      aria-current={on ? 'page' : undefined}
      className={cn('min-h-11 flex-1 rounded-md px-4 py-2.5 text-center text-sm font-medium transition-colors', on ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
    >
      {label}
    </Link>
  )
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <UtensilsCrossed className="size-5" />
        <h1 className="text-xl font-semibold">Food</h1>
      </div>
      <nav className="flex gap-1 rounded-lg bg-muted p-1" aria-label="Food sections">
        {tab('/food', 'Orders', active === 'orders')}
        {tab('/food/menu', 'Menu settings', active === 'menu')}
      </nav>
    </div>
  )
}
