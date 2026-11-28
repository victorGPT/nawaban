export const TIERS = ['P0', 'P1', 'P2'] as const
export type Tier = (typeof TIERS)[number]
const TIER_OF_A_TICKET_MADE_BEFORE_TIERS = 'P2'
export const VISIBLE_BUG = '线上可见 bug'
export const isTier = (word: string | undefined): word is Tier => (TIERS as readonly (string | undefined)[]).includes(word)
export const tierOf = (labels: Record<string, string>): Tier => (isTier(labels.priority) ? labels.priority : TIER_OF_A_TICKET_MADE_BEFORE_TIERS)
const higher = (a: Tier, b: Tier) => (TIERS.indexOf(a) <= TIERS.indexOf(b) ? a : b)
export const byTier = (a: Tier, b: Tier) => TIERS.indexOf(a) - TIERS.indexOf(b)

export function tiersRaisedToWhatTheyBlock(tasks: { id: string; tier: Tier; needs: readonly string[] }[]): Map<string, Tier> {
  const dependents = Map.groupBy(tasks.flatMap((t) => t.needs.map((need) => ({ need, t }))), ({ need }) => need)
  const out = new Map<string, Tier>()
  const raised = (t: (typeof tasks)[number], onThePath: Set<string>): Tier => {
    const known = out.get(t.id)
    if (known) return known
    onThePath.add(t.id)
    const tier = (dependents.get(t.id) ?? []).filter(({ t: d }) => !onThePath.has(d.id)).reduce((best, { t: d }) => higher(best, raised(d, onThePath)), t.tier)
    out.set(t.id, tier)
    return tier
  }
  for (const t of tasks) raised(t, new Set())
  return out
}

export const TIER_MEANING = 'P0 线上正在坏且影响大、合规安全、发版卡住；P1 线上可见的小 bug、推没达标/量不了/未测的 KR；P2 其余；挡住别的票的随被挡的票同档'
