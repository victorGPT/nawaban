import { parseArgs } from 'node:util'
import { BoardError, block, type board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { SCHEMAS, type SchemaId } from './schemas.ts'

/** The embedded CLI: runs argv as `nawaban …` would, and answers its exit code. */
type Run = (argv: string[]) => Promise<number>
type Team = ReturnType<typeof board>

const KINDS = ['note', 'decision', 'link', 'ask', 'resolve'] as const

function refuse(headline: string, code = 1) {
  process.stderr.write(`error: ${headline}\n`)
  return code
}

/** The data for one of our schemas, or why it doesn't match, checked here so nothing half lands. */
function data(id: SchemaId, value: Record<string, unknown>): { text: string } | { why: string } {
  const why = checkValue(SCHEMAS[id].schema, value)
  return why ? { why: `the ${id} block doesn't match its schema: ${why}` } : { text: block(id, value) }
}

/** `choice｜trade-off｜one-way` as an option of a card. */
function option(words: string) {
  const [choice, tradeoff, door] = words.split(/[｜|]/).map((part) => part.trim())
  return { choice, tradeoff, door }
}

/** What holds the task (null for nothing) and the thread's newest message, or the board's error said as a refusal. */
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

/**
 * `nawaban event <id> --kind note|decision|link|ask|resolve`: a reply on the task, with our block,
 * and for ask, resolve, and the triage notes, the hold a person lifts.
 */
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
        kr: { type: 'string' },
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
  const id = positionals[0]
  const kind = a.kind as (typeof KINDS)[number]
  if (!id || positionals.length > 1 || !KINDS.includes(kind)) {
    return refuse(`usage: nawaban event <id> --kind ${KINDS.join('|')} …`, 2)
  }
  if (a.by !== undefined && (kind !== 'decision' || a.by !== 'user')) return refuse('--by user goes only with --kind decision', 2)
  const as = a.as ? ['--as', a.as] : []
  const reply = (text: string) => run(['reply', id, text, ...as])
  const hold = (reason: string, kind: string) => run(['tasks', 'block', id, reason, '--kind', kind, ...as])
  // As the person, whatever profile the run writes as: the owner lifts a hold, whichever window wrote it.
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
  /**
   * Answers a hold of `kind`, then lifts it. The answer goes in only while the message read is still
   * the newest (`--after`), and the hold is lifted only while the answer is still the newest, so a
   * new hold raised meanwhile stays. A refused answer changes nothing.
   * ponytail: the board has no unblock-if-still-held, so a resolve and a new ask both landing between
   * the last read and the unblock (back-to-back calls) would still lift the new one.
   */
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
  /** The hold, then the reply; a reply that fails lifts the hold again, so no hold waits on nothing. */
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
      // 等你: the hold ends the claim (docs/01-board/11-tasks.md, "Hold a task for a person").
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
    // The older form: --body "Question: …\nVerdict: …\nRejected: …", a line each, Rejected repeatable.
    const line = (key: string) => [...(a.body ?? '').matchAll(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'gm'))].map((m) => m[1]!.trim())
    const value = data('nawaban-decision@1', {
      question: a.question ?? line('Question')[0],
      verdict: a.verdict ?? line('Verdict')[0],
      rejected: a.rejected ?? line('Rejected'),
      by: a.by === 'user' ? 'user' : 'agent',
      ...(a.kr ? { kr: a.kr } : {}),
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
      kr: a.kr,
      context: a.context,
      options: (a.option ?? []).map(option),
      recommendation: a.rec,
    })
    if ('why' in card) return refuse(card.why)
    // The hold is the pending decision: a task already held refuses a second one, before the card lands.
    return holdThenReply(a.body!, 'awaiting_approval', card.text)
  }

  const words = data('nawaban-resolve@1', { words: a.body })
  if ('why' in words) return refuse(words.why)
  return (
    (await answer('awaiting_approval', words.text, (newest) => newest.blocks.some((b) => b.schema === 'nawaban-resolve'))) ??
    refuse(`#${id} has no decision waiting`)
  )
}
