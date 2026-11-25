import { createApp, type Failure } from '@vercel/board/cli'

export const EXIT = { done: 0, refused: 1, misused: 2, waiting: 3 } as const

export class Refused extends Error {
  code: number
  next: string | undefined
  constructor(message: string, code: number = EXIT.refused, next?: string) {
    super(message)
    this.code = code
    this.next = next
  }
}

export type Said = { done: string; more?: string; json: object } | { shown: string; json: object; exit?: typeof EXIT.waiting }

const BEFORE_POSITIONALS_ONLY = '--'
const argsBeforePositionalsOnly = (argv: string[]) => (argv.includes(BEFORE_POSITIONALS_ONLY) ? argv.slice(0, argv.indexOf(BEFORE_POSITIONALS_ONLY)) : argv)
const wantsJson = (argv: string[]) => argsBeforePositionalsOnly(argv).includes('--json')

const ASK_FOR_HELP = '加 --help 看这个动词的参数'
const MISREAD: Record<string, string> = {
  ERR_PARSE_ARGS_UNKNOWN_OPTION: '不认识的参数',
  ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL: '多出来的位置参数',
  ERR_PARSE_ARGS_INVALID_OPTION_VALUE: '参数缺值或值不对',
}
const NAMED_IN_QUOTES = /'([^']+)'/
const misread = (error: unknown) => String((error as { code?: unknown }).code ?? '').startsWith('ERR_PARSE_ARGS')
const whyOf = (error: unknown) => {
  const { message } = error as Error
  if (!misread(error)) return message
  const named = NAMED_IN_QUOTES.exec(message)?.[1]
  return [MISREAD[(error as { code: string }).code] ?? '参数不对', named].filter(Boolean).join('：')
}
const exitOf = (error: unknown) => (error instanceof Refused ? error.code : misread(error) ? EXIT.misused : EXIT.refused)

function say(json: boolean, said: Said): number {
  const text = 'done' in said ? [`✓ ${said.done}`, ...(said.more ? ['', said.more] : [])].join('\n') : said.shown
  if (json || text) process.stdout.write((json ? JSON.stringify(said.json) : text) + '\n')
  return ('exit' in said && said.exit) || EXIT.done
}

function refusal(json: boolean, error: unknown): number {
  const code = exitOf(error)
  const why = whyOf(error)
  const next = error instanceof Refused ? error.next : misread(error) ? ASK_FOR_HELP : undefined
  process.stderr.write((json ? JSON.stringify({ error: why, ...(next ? { next } : {}), code }) : [`✗ ${why}`, ...(next ? [`  ${next}`] : [])].join('\n')) + '\n')
  return code
}

export const answer = (argv: string[], work: () => Promise<Said>) => work().then((said) => say(wantsJson(argv), said), (error) => refusal(wantsJson(argv), error))
export const orRefusal = (argv: string[], work: () => Promise<number>) => work().catch((error) => refusal(wantsJson(argv), error))

async function stdoutMutedWhile<T>(work: () => Promise<T>): Promise<{ value: T; printed: string }> {
  const write = process.stdout.write
  let printed = ''
  process.stdout.write = ((chunk: string | Uint8Array) => ((printed += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()), true)) as typeof write
  try {
    return { value: await work(), printed }
  } finally {
    process.stdout.write = write
  }
}

const withJson = (argv: string[]) => {
  const at = argv.indexOf(BEFORE_POSITIONALS_ONLY)
  return at < 0 ? [...argv, '--json'] : [...argv.slice(0, at), '--json', ...argv.slice(at)]
}

export async function upstreamAnswer(argv: string[]): Promise<Record<string, unknown>> {
  let failure: Failure | undefined
  const app = createApp({ appName: 'nawaban', onError: (f) => void (failure = f) })
  const { value: code, printed } = await stdoutMutedWhile(() => app.run(withJson(argv)))
  if (code) throw new Refused([failure?.message, ...(failure?.details ?? [])].filter(Boolean).join('：') || `看板拒了 ${argv.slice(0, 2).join(' ')}`, code === EXIT.misused ? EXIT.misused : EXIT.refused)
  return JSON.parse(printed.trim() || '{}')
}

export const upstreamQuietly = (argv: string[]) => upstreamAnswer(argv).then(() => EXIT.done)
