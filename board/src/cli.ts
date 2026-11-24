#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { board } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { dispatch } from './dispatch.ts'
import { event } from './events.ts'
import { guard } from './guard.ts'
import { importOld } from './import.ts'
import { merge } from './merge.ts'
import { jsonOkr, okr } from './okr.ts'
import { inbox, index, page } from './orchestrator.ts'
import { boardDirAsConfiguredWhenAsked, DIR, PORT, serve, urlFor, web, webOverTailnet } from './server.ts'
import { githubIssuesHeldBy, progress } from './progress.ts'
import { heldBy, run } from './tasks.ts'
import { json } from './views.ts'

type Group = '看' | '写' | '派' | '少用' | '本机服务' | '上游'
type Run = (rest: string[]) => Promise<number>
type Command = { group: Group; usage: string; about: string; flags?: [flag: string, about: string][]; helpIsUpstreams?: true; run: Run }

const MISUSE = 2
const GAP_BEFORE_ABOUT = 2
const MAIN_SCREEN: Group[] = ['看', '写', '派']
const MORE_SCREEN: Group[] = ['少用', '本机服务', '上游']
const HELP_FLAGS = new Set(['--help', '-h'])
const DOUBLE_WIDTH = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u
const SHELL_SAFE_WORD = /^[\w@%+=:,./-]+$/
const UPSTREAM_VERBS = ['whoami', 'grants', 'channels', 'schemas', 'actors', 'read', 'post', 'reply', 'schedule', 'schedules', 'edit', 'delete', 'react', 'label', 'typing', 'sync', 'sources', 'download', 'conformance', 'tasks', 'hooks', 'tail', 'wait']

function tokenOfServedBoardElseLetItsOwn401Answer(): string | undefined {
  try {
    return readFileSync(join(DIR, 'token'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function pointAtThisMachinesBoard() {
  process.env.BOARD_URL ??= urlFor(PORT)
  if (process.env.BOARD_TOKEN) return
  const token = tokenOfServedBoardElseLetItsOwn401Answer()
  if (token !== undefined) process.env.BOARD_TOKEN = token
}

const app = createApp({ appName: 'nawaban' })
const upstream = createApp({ appName: 'nawaban board' })
const taskVerb = (verb: string): Run => async (rest) => (await run([verb, ...rest]))!

const misused = (usage: string) => {
  process.stderr.write(`用法：nawaban ${usage}\n`)
  return MISUSE
}

const HOOKS: Record<string, Run> = {
  renew: taskVerb('renew'),
  progress: () => progress(async (session) => [...(await heldBy(session)), ...githubIssuesHeldBy(DIR, session)], DIR),
  guard: () => guard(board(), DIR),
}

const COMMANDS: Record<string, Command> = {
  status: {
    group: '看',
    usage: 'status',
    about: '现在要管的：待决、停滞、进行中、可开工',
    flags: [['--project <项目>', '只看这个项目，末尾接上网页已答和收件箱']],
    run: (rest) => index(rest, board()),
  },
  show: { group: '看', usage: 'show <票>', about: '一张票：正文、负责人、被挡、最近事件', flags: [['--json', '输出 JSON']], run: taskVerb('show') },
  list: {
    group: '看',
    usage: 'list',
    about: '票，一行一张',
    flags: [
      ['--project <项目>', '只列这个项目；不带就列全部'],
      ['--parent <票>', '只列这张票下的'],
      ['--frontier', '只列可开工的'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('list'),
  },
  okr: {
    group: '看',
    usage: 'okr',
    about: '各 O 的 KR 读数对目标',
    flags: [['--accept <O>', '记下决策者验收这个 O，只在它这一轮全达标时']],
    run: (rest) => okr(rest, board(), DIR),
  },
  create: {
    group: '写',
    usage: 'create <票>',
    about: '建票',
    flags: [
      ['--title <标题>', '必填'],
      ['--body <正文>', '正文'],
      ['--body-file <文件>', '正文从文件读'],
      ['--parent <票>', '挂在这张票下，项目随它'],
      ['--project <项目>', '没有 --parent 时必填'],
      ['--blocked-by <票>', '被这张票挡，可重复'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('create'),
  },
  claim: {
    group: '写',
    usage: 'claim <票>',
    about: '认领；--release 交还',
    flags: [
      ['--release', '交还'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('claim'),
  },
  event: {
    group: '写',
    usage: 'event <票>',
    about: '记事件：--kind note|decision|link|impact|ask|resolve',
    flags: [
      ['--kind <类>', '必填：note decision link impact ask resolve'],
      ['--body <正文>', 'impact 以外都要'],
      ['--by user', '决策者定的，只用于 decision'],
      ['--kr <KR>', 'decision、ask 挂的 KR'],
      ['--kr "<KR>=↑ 90→95 预计"', 'impact 的 KR 和方向，可重复'],
      ['--o <O>', 'impact 的 O，纯基础设施写 无'],
      ['--context <背景>', 'ask 的背景'],
      ['--option <方案｜代价｜门>', 'ask 的选项，至少两次'],
      ['--rec <建议>', 'ask 的建议'],
      ['--as <身份>', '用这个身份记'],
    ],
    run: (rest) => event(rest, (args) => app.run(args), board()),
  },
  close: {
    group: '写',
    usage: 'close <票>',
    about: '关票：--done 或 --cancelled',
    flags: [
      ['--done', '做完了'],
      ['--cancelled', '作废，等它的票不再等'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('close'),
  },
  dispatch: {
    group: '派',
    usage: 'dispatch <票>',
    about: '把票派给 worker',
    flags: [
      ['--brief <文本>', '目标和范围，必填'],
      ['--accept <文本>', '怎样算做完，必填'],
      ['--name <名>', 'worker 名；不带票时必填，什么都不记'],
      ['--agent claude|codex|agy', '默认 claude'],
      ['--model <模型>', 'claude 默认 opus'],
      ['--to <终端>', '交给这个终端'],
      ['--new', '新开 worker，不交给泳道里在跑的'],
    ],
    run: (rest) => dispatch(rest),
  },
  merge: { group: '派', usage: 'merge <PR>', about: '合并 PR，关票，交下一张', run: (rest) => merge(rest) },
  block: { group: '少用', usage: 'block <票> <挡它的票>', about: '建票之后补一条被挡', flags: [['--json', '输出 JSON']], run: taskVerb('block') },
  web: {
    group: '少用',
    usage: 'web',
    about: '在浏览器打开网页版；--tailnet 打印外网地址',
    flags: [['--tailnet', '打印外网地址，不开浏览器']],
    run: (rest) => (rest[0] === '--tailnet' ? webOverTailnet() : web()),
  },
  serve: {
    group: '本机服务',
    usage: 'serve',
    about: '起看板服务，launchd 调',
    run: async () => {
      await serve()
      return 0
    },
  },
  import: {
    group: '本机服务',
    usage: 'import',
    about: '从旧 nawaban.db 导入',
    flags: [
      ['--from <旧 nawaban.db>', '必填'],
      ['--project <项目>', '至少一个，可重复'],
      ['--repos <repos.md>', '项目到仓库路径的对照'],
    ],
    run: (rest) => importOld(rest, board().as(null), boardDirAsConfiguredWhenAsked()),
  },
  hook: {
    group: '本机服务',
    usage: 'hook <名>',
    about: '钩子入口 renew、progress、guard，不手敲',
    flags: [
      ['renew [--session <会话>]', '续租这个会话拿着的票'],
      ['progress', '从标准输入读钩子输入，记进展'],
      ['guard', '从标准输入读 PreToolUse 输入，拦下时退出 2'],
    ],
    run: ([name, ...rest]) => (name !== undefined && Object.hasOwn(HOOKS, name) ? HOOKS[name]!(rest) : Promise.resolve(misused('hook renew|progress|guard'))),
  },
  json: {
    group: '本机服务',
    usage: 'json <什么>',
    about: '面板读的 JSON，不手敲',
    flags: [
      ['projects', '各项目'],
      ['db', '板文件路径'],
      ['board [--project <项目>]', '看板各列'],
      ['task <票>', '一张票的详情'],
      ['okr [--repo <路径>]', 'KR 读数，不跑量法'],
    ],
    run: (rest) => (rest[0] === 'okr' ? jsonOkr(rest.slice(1), board(), DIR) : json(rest, board(), DIR)),
  },
  inbox: { group: '本机服务', usage: 'inbox', about: '待决提示行，Stop 钩子读的，不手敲', flags: [['--project <项目>', '项目']], run: (rest) => inbox(rest, board(), DIR) },
  page: {
    group: '本机服务',
    usage: 'page',
    about: '网页已答和收件箱，提示词钩子读的，不手敲',
    flags: [
      ['--project <项目>', '必填'],
      ['--session <会话>', '只给这个会话没见过的'],
    ],
    run: (rest) => page(rest, board(), DIR),
  },
  board: {
    group: '上游',
    usage: 'board <动词…>',
    about: '@vercel/board 的原生动词：nawaban board --help',
    helpIsUpstreams: true,
    run: (rest) => upstream.run(rest.length ? rest : ['--help']),
  },
}

const RENAMED: Record<string, string[]> = {
  index: ['status'],
  renew: ['hook', 'renew'],
  progress: ['hook', 'progress'],
  guard: ['hook', 'guard'],
  ...Object.fromEntries(UPSTREAM_VERBS.map((verb) => [verb, ['board', verb]])),
}

const columns = (text: string) => [...text].reduce((n, c) => n + (DOUBLE_WIDTH.test(c) ? 2 : 1), 0)
const paddedTo = (text: string, width: number) => text + ' '.repeat(width - columns(text))

function aligned(rows: [left: string, right: string][]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => columns(left))) + GAP_BEFORE_ABOUT
  return rows.map(([left, right]) => `  ${paddedTo(left, width)}${right}`)
}

function screen(groups: Group[]): string[] {
  const shown = Object.values(COMMANDS).filter((c) => groups.includes(c.group))
  const lines = aligned(shown.map((c) => [c.usage, c.about]))
  return groups.flatMap((group) => [group, ...lines.filter((_, i) => shown[i]!.group === group)])
}

const MAIN_HELP = [
  'nawaban：记票、事件、待决和读数的看板',
  '',
  '用法：nawaban <动词> [参数]',
  '',
  ...screen(MAIN_SCREEN),
  '',
  '<票> 是 KEY 或板上的编号。',
  '每个动词加 --help 看参数。',
  '少用的和本机服务：nawaban help more',
]
const MORE_HELP = screen(MORE_SCREEN)

const helpOf = (c: Command) => [`用法：nawaban ${c.usage}`, c.about, ...aligned(c.flags ?? [])]

const asksForHelp = (rest: string[]) => HELP_FLAGS.has(rest[0] ?? '') || (HELP_FLAGS.has(rest.at(-1) ?? '') && !(rest.at(-2) ?? '').startsWith('-'))

const printed = (lines: string[]) => {
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

const shellWord = (word: string) => (SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

function noSuchVerb(word: string) {
  process.stderr.write([`✗ 没有动词 ${word}`, ...screen(MAIN_SCREEN)].join('\n') + '\n')
  return MISUSE
}

async function runCommand(argv: string[]): Promise<number> {
  const [word, ...rest] = argv
  if (word === undefined || word === 'help' || HELP_FLAGS.has(word)) return printed(rest[0] === 'more' ? MORE_HELP : MAIN_HELP)
  if (Object.hasOwn(RENAMED, word)) {
    const renamed = [...RENAMED[word]!, ...rest]
    process.stderr.write(`改用：nawaban ${renamed.map(shellWord).join(' ')}\n`)
    return runCommand(renamed)
  }
  if (!Object.hasOwn(COMMANDS, word)) return noSuchVerb(word)
  const command = COMMANDS[word]!
  if (!command.helpIsUpstreams && asksForHelp(rest)) return printed(helpOf(command))
  return command.run(rest)
}

const argv = process.argv.slice(2)
const serveKeepsTheEnvironmentLaunchdGaveIt = argv[0] === 'serve'
if (!serveKeepsTheEnvironmentLaunchdGaveIt) pointAtThisMachinesBoard()
process.exitCode = await runCommand(argv)
