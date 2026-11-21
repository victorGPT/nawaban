import { parseArgs } from 'node:util'
import { BoardError, block, type board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { SCHEMAS, type SchemaId } from './schemas.ts'
import { IMPACT_FORMAT } from './impact.ts'
import { Refused, resolve } from './tasks.ts'

type Run = (argv: string[]) => Promise<number>
type Team = ReturnType<typeof board>

const KINDS = ['note', 'decision', 'link', 'ask', 'resolve', 'impact'] as const

const IMPACT = /^(.+)=([↑↓=])(?:\s+(-?\d+(?:\.\d+)?%?)\s*→\s*(-?\d+(?:\.\d+)?%?)\s+(实测|预计))?\s*$/

function refuse(headline: string, code = 1) {
  process.stderr.write(`error: ${headline}\n`)
  return code
}

function data(id: SchemaId, value: Record<string, unknown>): { text: string } | { why: string } {
  const why = checkValue(SCHEMAS[id].schema, value)
  return why ? { why: `the ${id} block doesn't match its schema: ${why}` } : { text: block(id, value) }
}

function option(words: string) {
  const [choice, tradeoff, door] = words.split(/[｜|]/).map((part) => part.trim())
  return { choice, tradeoff, door }
}

type Thread = Awaited<ReturnType<Team['thread']>>
async function blocked(team: Team, id: string): Promise<{ error: number } | { hold: NonNullable<Thread['message']['task']>['blocked']; newest: Thread['message'] }> {
  try {
    const { message, replies } = await team.thread(id)
    return { hold: message.task?.blocked ?? null, newest: replies.at(-1) ?? message }
  } catch (error) {
    if (error instanceof BoardError) return { error: refuse(`Couldn't read task #${id}: ${error.message}`) }
    throw error
  }
}

export async function event(argv: string[], run: Run, team: Team): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        kind: { type: 'string' },
        body: { type: 'string' },
        by: { type: 'string' },
        kr: { type: 'string', multiple: true },
        o: { type: 'string' },
        question: { type: 'string' },
        verdict: { type: 'string' },
        rejected: { type: 'string', multiple: true },
        context: { type: 'string' },
        option: { type: 'string', multiple: true },
        rec: { type: 'string' },
        as: { type: 'string' },
      },
    })
  } catch (error) {
    return refuse((error as Error).message, 2)
  }
  const { values: a, positionals } = parsed
  let id = positionals[0]
  const kind = a.kind as (typeof KINDS)[number]
  if (!id || positionals.length > 1 || !KINDS.includes(kind)) {
    return refuse(`usage: nawaban event <key|id> --kind ${KINDS.join('|')} …`, 2)
  }

  try {
    id = (await resolve(id)).id
  } catch (error) {
    if (error instanceof Refused) return refuse(error.message)
    throw error
  }
  if (a.by !== undefined && (kind !== 'decision' || a.by !== 'user')) return refuse('--by user goes only with --kind decision', 2)
  if ((a.o !== undefined) !== (kind === 'impact')) return refuse('an impact takes --o "<O 名>" (纯基础设施写 --o 无), and only an impact does', 2)
  if (kind !== 'impact' && (a.kr?.length ?? 0) > 1) return refuse('--kr goes once, but for an impact', 2)
  const kr = a.kr?.[0]
  const as = a.as ? ['--as', a.as] : []
  const reply = (text: string) => run(['reply', id, text, ...as])
  const hold = (reason: string, kind: string) => run(['tasks', 'block', id, reason, '--kind', kind, ...as])

  const unblock = async () => {
    try {
      await team.as(null).tasks.unblock(id)
    } catch (error) {
      if (error instanceof BoardError) return refuse(`Couldn't unblock task #${id}: ${error.message}`)
      throw error
    }
    process.stdout.write(`unblocked ${id}\n`)
    return 0
  }

  const answer = async (kind: string, text: string, ours: (newest: { blocks: { schema: string }[]; text: string }) => boolean) => {
    const before = await blocked(team, id)
    if ('error' in before) return before.error
    if (before.hold?.kind !== kind) return null
    const posted = await run(['reply', id, text, '--after', before.newest.id, ...as])
    if (posted) return posted
    const after = await blocked(team, id)
    if ('error' in after) return after.error
    if (after.hold?.kind !== kind || !ours(after.newest)) return refuse(`#${id} changed while answering: answered, hold left as it is`)
    return unblock()
  }

  const holdThenReply = async (reason: string, kind: string, text: string) => {
    const held = await hold(reason, kind)
    if (held) return held
    const posted = await reply(text)
    if (posted) await unblock()
    return posted
  }

  if (kind === 'note') {
    if (!a.body) return refuse('a note needs --body', 2)
    const triage = /^\s*triage:\s*([\w-]+)/.exec(a.body)?.[1]
    if (triage === 'needs-info') {
      const question = a.body.split(/等你[：:]/)[1]?.trim() || a.body
      return holdThenReply(question, 'needs_input', a.body)
    }
    if (triage === 'ready-for-agent') {
      const held = await blocked(team, id)
      if ('error' in held) return held.error
      if (held.hold && held.hold.kind !== 'needs_input') return refuse(`#${id} is held for a decision: resolve it with --kind resolve`)
      if (!held.hold) return reply(a.body)
      return (await answer('needs_input', a.body, (newest) => newest.text === a.body)) ?? reply(a.body)
    }
    return reply(a.body)
  }

  if (kind === 'decision') {
    const line = (key: string) => [...(a.body ?? '').matchAll(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'gm'))].map((m) => m[1]!.trim())
    const value = data('nawaban-decision@1', {
      question: a.question ?? line('Question')[0],
      verdict: a.verdict ?? line('Verdict')[0],
      rejected: a.rejected ?? line('Rejected'),
      by: a.by === 'user' ? 'user' : 'agent',
      ...(kr ? { kr } : {}),
    })
    return 'why' in value ? refuse(`${value.why} (--question, --verdict, --rejected; or --body with Question:, Verdict:, Rejected: lines)`) : reply(value.text)
  }

  if (kind === 'link') {
    const [, linkKind, ref] = /^(\w+):(.+)$/s.exec(a.body ?? '') ?? []
    const value = data('nawaban-link@1', { kind: linkKind, ref })
    return 'why' in value ? refuse(`${value.why} (--body pr:<url>, commit:<sha>, artifact:<ref>, adr:<ref>)`) : reply(value.text)
  }

  if (kind === 'ask') {
    const card = data('nawaban-ask@1', {
      decision: a.body,
      kr,
      context: a.context,
      options: (a.option ?? []).map(option),
      recommendation: a.rec,
    })
    if ('why' in card) return refuse(card.why)

    return holdThenReply(a.body!, 'awaiting_approval', card.text)
  }

  if (kind === 'impact') {
    if (a.body || a.context || a.option || a.rec || a.question || a.verdict || a.rejected) return refuse('an impact takes only --o and --kr', 2)
    const krs = []
    for (const spec of a.kr ?? []) {
      const [, name, dir, before, after, basis] = IMPACT.exec(spec) ?? []
      if (!name) return refuse(`--kr is ${IMPACT_FORMAT}, numbers before→after: ${spec}`, 2)
      krs.push(Object.fromEntries(Object.entries({ name: name.trim(), dir, before, after, basis }).filter(([, v]) => v !== undefined)))
    }

    const value = data('nawaban-impact@1', { objective: a.o, krs })
    return 'why' in value ? refuse(`${value.why} (↑↓ need numbers before→after and 实测|预计)`) : reply(value.text)
  }

  const words = data('nawaban-resolve@1', { words: a.body })
  if ('why' in words) return refuse(words.why)
  return (
    (await answer('awaiting_approval', words.text, (newest) => newest.blocks.some((b) => b.schema === 'nawaban-resolve'))) ??
    refuse(`#${id} has no decision waiting`)
  )
}
