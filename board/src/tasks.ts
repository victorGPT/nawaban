import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { board, type MessageView } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { undeclared } from './impact.ts'
import { boardDir } from './server.ts'

type Verb = (argv: string[]) => Promise<number>

const LEASE = '1h'
const person = () => board().as(null)
const vb = (argv: string[]) => createApp({ appName: 'nawaban' }).run(argv)

export class Refused extends Error {
  code: number
  constructor(message: string, code = 1) {
    super(message)
    this.code = code
  }
}

export function profile(session = process.env.CLAUDE_CODE_SESSION_ID): string {
  if (session) return `cc-${session.slice(0, 8)}`.toLowerCase()
  const owner = process.env.NAWABAN_OWNER
  if (!owner) throw new Refused('no identity: set CLAUDE_CODE_SESSION_ID, or NAWABAN_OWNER outside Claude Code', 2)
  if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(owner)) {
    throw new Refused(`NAWABAN_OWNER ${owner} isn't a profile name: a letter, then up to 31 letters, numbers, and hyphens`, 2)
  }
  return owner.toLowerCase()
}

const key = (m: MessageView) => m.labels.key ?? `#${m.id}`
const title = (m: MessageView) => m.text.split('\n')[0]
const live = (m: MessageView) => {
  const claim = m.task?.claim
  return claim && Date.parse(claim.until) > Date.now() ? claim : null
}

const holder = (actor: string) => {
  const [who, as] = actor.slice(actor.lastIndexOf(':') + 1).split('+')
  return as ? `${as} via ${who}` : who
}
const state = (m: MessageView) => (m.task?.state === 'claimed' && !live(m) ? 'ready' : m.task?.state ?? 'not a task')

async function all(query: Parameters<ReturnType<typeof board>['tasks']['list']>[0]) {
  const team = person()
  const out: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ ...query, after, limit: 50 })
    out.push(...page.tasks.map((t) => t.message))
    if (page.tasks.length < 50) return out
    after = page.cursor
  }
}

export async function resolve(ref: string): Promise<MessageView> {
  const [found] = await all({ state: 'all', label: { key: ref } })
  if (found) return found
  const message = await person()
    .thread(ref, { limit: 1 })
    .then((t) => t.message)
    .catch(() => null)
  if (!message?.task) throw new Refused(`no task ${ref}`)
  return message
}

const print = (json: boolean, doc: unknown, text: string) => process.stdout.write(json ? JSON.stringify(doc) + '\n' : text + '\n')
const row = (m: MessageView) => `#${m.id}  ${state(m).padEnd(9)}  ${key(m)}  ${title(m)}`

const create: Verb = async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      parent: { type: 'string' },
      project: { type: 'string' },
      'blocked-by': { type: 'string', multiple: true },
      json: { type: 'boolean' },
    },
  })
  const [id] = positionals
  if (!id || !values.title) throw new Refused('usage: nawaban create <key> --title "<title>" [--body ...] [--parent <key>] [--project <p>] [--blocked-by <key>]...', 2)
  const parent = values.parent ? await resolve(values.parent) : null
  const project = values.project ?? parent?.channel
  if (!project) throw new Refused('no project: pass --project, or a --parent that has one', 2)
  const body = values['body-file'] ? readFileSync(values['body-file'], 'utf8') : values.body
  const needs = await Promise.all((values['blocked-by'] ?? []).map(async (b) => (await resolve(b)).id))

  const { task } = await person().tasks.create(project, {
    id,
    text: body ? `${values.title}\n\n${body}` : values.title,
    labels: { key: id, ...(parent ? { parent: key(parent) } : {}) },
    needs,
  })
  print(!!values.json, { task }, row(task))
  return 0
}

const block: Verb = async (argv) => {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } })
  const [ref, by] = positionals
  if (!ref || !by || positionals.length !== 2) throw new Refused('usage: nawaban block <key> <blocker>', 2)
  const [task, blocker] = await Promise.all([resolve(ref), resolve(by)])
  const needs = [...new Set([...(task.task?.needs ?? []), blocker.id])]
  const updated = await person().tasks.needs(task.id, needs)
  print(!!values.json, { task: updated }, `${key(task)} blocked by ${key(blocker)}`)
  return 0
}

const list: Verb = async (argv) => {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: 'string' }, parent: { type: 'string' }, frontier: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const tasks = await all({
    channel: values.project,
    state: values.frontier ? 'ready' : 'open',
    label: values.parent ? { parent: values.parent } : undefined,
  })
  print(!!values.json, { tasks }, tasks.map(row).join('\n') || 'no tasks')
  return 0
}

const show: Verb = async (argv) => {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } })
  const [ref] = positionals
  if (!ref || positionals.length !== 1) throw new Refused('usage: nawaban show <key>', 2)
  const task = await resolve(ref)
  const team = person()
  const [needs, downstream, summary] = await Promise.all([
    Promise.all((task.task?.needs ?? []).map((id) => team.thread(id, { limit: 1 }).then((t) => t.message))),
    all({ state: 'all', needs: task.id }),
    team.threads({ re: task.id, limit: 1 }),
  ])
  const latest = summary.threads[0]?.last ?? null
  const claim = live(task)
  const lines = [
    row(task),
    task.text.split('\n').slice(2).join('\n').trim() || undefined,
    '',
    `  project     ${task.channel}`,
    task.labels.parent && `  parent      ${task.labels.parent}`,
    `  holder      ${claim ? `${holder(claim.actor)} · until ${claim.until}` : 'none'}`,
    claim && task.labels.terminal && `  terminal    ${task.labels.terminal}`,
    task.task?.blocked && `  held        ${JSON.stringify(task.task.blocked)}`,
    `  blocked by  ${needs.map((m) => `${key(m)} ${state(m)}`).join(', ') || 'nothing'}`,
    `  downstream  ${downstream.map((m) => `${key(m)} ${state(m)}`).join(', ') || 'nothing'}`,
    `  latest      ${latest ? `${latest.author?.handle ?? '?'} · ${latest.createdAt}  ${latest.text.split('\n')[0]}` : 'nothing yet'}`,
  ]
  print(!!values.json, { task, needs, downstream, latest }, lines.filter((l) => typeof l === 'string').join('\n'))
  return 0
}

const terminal = () => (process.env.CLAUDE_CODE_SESSION_ID ? process.env.HC_TERMINAL_ID : undefined)

const claim: Verb = async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { release: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const [ref] = positionals
  if (!ref || positionals.length !== 1) throw new Refused('usage: nawaban claim <key> [--release]', 2)
  const task = await resolve(ref)
  const as = profile()
  const json = values.json ? ['--json'] : []
  if (values.release) {
    const code = await vb(['tasks', 'release', task.id, '--as', as, ...json])
    if (code === 0) await person().label(task.id, { unset: ['terminal'] })
    return code
  }
  const code = await vb(['tasks', 'claim', task.id, '--as', as, '--lease', LEASE, ...json])

  const t = terminal()
  if (code === 0) await person().label(task.id, t ? { set: { terminal: t } } : { unset: ['terminal'] })
  return code
}

const close: Verb = async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { done: { type: 'boolean' }, cancelled: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const [ref] = positionals
  if (!ref || positionals.length !== 1 || !!values.done === !!values.cancelled) throw new Refused('usage: nawaban close <key> (--done | --cancelled)', 2)
  const task = await resolve(ref)
  const json = values.json ? ['--json'] : []
  const team = person()
  if (values.done) {
    const why = await undeclared(team, task.id, boardDir())
    if (why) throw new Refused(why)
    const as = profile()
    const held = live(task)
    if (held && !held.actor.endsWith(`+${as}`)) {
      throw new Refused(`${key(task)} is held by ${holder(held.actor)} until ${held.until}: let it close it, or wait out its lease`)
    }
    if (!held) {
      const code = await vb(['tasks', 'claim', task.id, '--as', as, '--lease', LEASE, ...json])
      if (code !== 0) return code
    }
    const code = await vb(['tasks', 'complete', task.id, '--as', as, ...json])
    if (code === 0) await team.label(task.id, { unset: ['terminal'] })
    return code
  }

  if (task.task?.state !== 'canceled') await team.tasks.cancel(task.id, 'cancelled')
  await team.label(task.id, { unset: ['terminal'] })
  const stuck: string[] = []
  for (const down of await all({ state: 'open', needs: task.id })) {
    try {
      const kept = await Promise.all(
        (down.task?.needs ?? []).map(async (id) =>
          id === task.id || (await team.thread(id, { limit: 1 })).message.task?.state === 'canceled' ? null : id,
        ),
      )
      await team.tasks.needs(down.id, kept.filter((id) => id !== null))
    } catch (error) {
      stuck.push(`${key(down)} (${(error as Error).message})`)
    }
  }
  if (stuck.length) throw new Refused(`canceled ${key(task)}, but these still wait for it: ${stuck.join(', ')}. Run this again once no one holds them`)
  print(!!values.json, { canceled: task.id }, `canceled ${key(task)}`)
  return 0
}

const renew: Verb = async (argv) => {
  const { values } = parseArgs({ args: argv, options: { session: { type: 'string' }, json: { type: 'boolean' } } })
  const as = profile(values.session)
  let code = 0
  for (const task of await all({ state: 'claimed' })) {
    const claim = live(task)

    if (claim?.actor.endsWith(`+${as}`)) code = (await vb(['tasks', 'renew', task.id, '--as', as, '--lease', LEASE, ...(values.json ? ['--json'] : [])])) || code
  }
  return code
}

const VERBS: Record<string, Verb> = { create, block, list, show, claim, close, renew }

export async function run(argv: string[]): Promise<number | undefined> {
  const verb = argv[0] !== undefined && Object.hasOwn(VERBS, argv[0]) ? VERBS[argv[0]] : undefined
  if (!verb) return undefined
  try {
    return await verb(argv.slice(1))
  } catch (error) {
    const refused = error instanceof Refused
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return refused ? error.code : (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 2 : 1
  }
}
