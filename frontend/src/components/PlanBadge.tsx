import { Crown, ShieldCheck, User } from 'lucide-react'

import { useAccess } from '../access/context'
import type { AccessPlan } from '../access/context'
import { Badge } from './ui/Badge'

const LABEL: Record<AccessPlan, string> = { anonymous: 'Guest', free: 'Free', pro: 'Pro', admin: 'Admin' }

export function PlanBadge({ plan }: { plan?: AccessPlan }) {
  const access = useAccess()
  const p = plan ?? access.plan
  const tone = p === 'admin' ? 'violet' : p === 'pro' ? 'teal' : 'neutral'
  const Icon = p === 'admin' ? ShieldCheck : p === 'pro' ? Crown : User
  return (
    <Badge tone={tone} data-testid="plan-badge" aria-label={`Plan: ${LABEL[p]}`}>
      <Icon className="h-3 w-3" aria-hidden /> {LABEL[p]}
    </Badge>
  )
}
