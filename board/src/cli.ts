#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { board } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { dispatch, tell } from './dispatch.ts'
import { askGuard } from './ask-guard.ts'
import { claimRegistering, event } from './events.ts'
import { pointAt, UPSTREAM_VERBS } from './hint.ts'
import { ghAccountGuard, guard } from './guard.ts'
import { importOld } from './import.ts'
import { merge } from './merge.ts'
import { jsonOkr, okr, okrStat } from './okr.ts'
import { status } from './orchestrator.ts'
import { boardDirAsConfiguredWhenAsked, DIR, PORT, serve, urlFor, web, webOverTailnet } from './server.ts'
import { oldCli } from './github.ts'
import { githubReplyHook, githubStateHook, share } from './github-push.ts'
import { githubImpactHook } from './github-impact.ts'
import { githubIssuesHeldBy, progress } from './progress.ts'
import { heldBy, run } from './tasks.ts'
import { json } from './views.ts'
import { upstreamQuietly } from './said.ts'

type Group = '看' | '写' | '派' | '少用' | '本机服务' | '上游'
type Run = (rest: string[]) => Promise<number>
type Command = { group: Group; usage: string; args?: string; about: string; flags?: [flag: string, about: string][]; helpIsUpstreams?: true; run: Run }

const MISUSE = 2
const GAP_BEFORE_ABOUT = 2
const MAIN_SCREEN: Group[] = ['看', '写', '派']
const MORE_SCREEN: Group[] = ['少用', '本机服务', '上游']
const HELP_FLAGS = new Set(['--help', '-h'])
const DOUBLE_WIDTH = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u
const BOARD_RESTART_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

function tokenOfServedBoardElseLetItsOwn401Answer(): string | undefined {
  try {
    return readFileSync(join(DIR, 'token'), 'utf8').trim()
  } catch {
    return undefined
  }
}

const refusedBeforeAnythingWasSent = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED'

function retryWhileTheBoardRestarts() {
  const fetchOnce = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    for (const backoff of BOARD_RESTART_BACKOFF_MS) {
      try {
        return await fetchOnce(input instanceof Request ? input.clone() : input, init)
      } catch (error) {
        if (!refusedBeforeAnythingWasSent(error)) throw error
      }
      await new Promise((wake) => setTimeout(wake, backoff))
    }
    return fetchOnce(input, init)
  }) as typeof fetch
}

function pointAtThisMachinesBoard() {
  process.env.BOARD_URL ??= urlFor(PORT)
  if (process.env.BOARD_TOKEN) return
  const token = tokenOfServedBoardElseLetItsOwn401Answer()
  if (token !== undefined) process.env.BOARD_TOKEN = token
}

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
  'gh-account': () => ghAccountGuard(DIR),
  'ask-guard': (rest) => askGuard(rest, { run: upstreamQuietly, team: board(), oldCli, dir: DIR }),
  'github-reply': (rest) => githubReplyHook(rest, board(), DIR),
  'github-state': (rest) => githubStateHook(rest, board(), DIR),
  'github-impact': (rest) => githubImpactHook(rest, board(), DIR),
}

const COMMANDS: Record<string, Command> = {
  status: {
    group: '看',
    usage: 'status',
    about: '现在要管的：待决、停滞、进行中、可开工',
    flags: [
      ['--project <项目>', '只看这个项目，末尾接上网页已答和收件箱；缺省是当前仓库的，不在仓库里看全部'],
      ['--line', '只打印待决提示行，从标准输入读 Stop 钩子输入，Stop 钩子用'],
      ['--unseen <会话>', '只打印这个会话没见过的网页已答和收件箱，提示词钩子用'],
      ['--json', '输出 JSON'],
    ],
    run: (rest) => status(rest, board(), DIR),
  },
  show: { group: '看', usage: 'show <票>', about: '一张票：正文、负责人、被挡、最近事件', flags: [['--all', '再列出全部事件'], ['--json', '输出 JSON']], run: taskVerb('show') },
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
    flags: [
      ['--accept <O>', '记下决策者验收这个 O，只在它这一轮全达标时'],
      ['--resume <O>', '硬停之后开新冲刺，要先有挂在这个 O 上、已 resolve 的待决策项'],
      ['--json', '输出 JSON'],
    ],
    run: (rest) => okr(rest, board(), DIR),
  },
  create: {
    group: '写',
    usage: 'create <票>',
    args: '--title <标题> [正文]',
    about: '建票',
    flags: [
      ['--title <标题>', '必填'],
      ['-', '正文从标准输入读'],
      ['--body-file <文件>', '正文从文件读'],
      ['--parent <票>', '挂在这张票下，项目随它'],
      ['--project <项目>', '缺省随 --parent，再缺省是当前仓库在 repos.json 里的项目'],
      ['--blocked-by <票>', '被这张票挡，可重复'],
      ['--lane <泳道>', '开工前要读同一批东西的一组票；dispatch 交给这条泳道在跑的 worker'],
      ['--inbox <条目>', '把这条收件箱条目转成这张票并标成已处理；不给正文就用条目原话，项目随条目'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('create'),
  },
  claim: {
    group: '写',
    usage: 'claim <票>',
    args: '| --ready',
    about: '认领；--release 交还；--o --kr 登记 KR 影响；--ready 领下一张',
    flags: [
      ['--release', '交还'],
      ['--ready', '不带票：领指派给你的下一张，没有就领池里最早的，打印接着干的 brief'],
      ['--wait <时长>', '和 --ready 一起：没票时等多久，例如 10m；不带就不等'],
      ['--project <项目>', '和 --ready 一起：缺省是当前仓库在 repos.json 里的项目'],
      ['--o <O>', '登记影响的 O，纯基础设施写 无'],
      ['--kr "<KR>=toward|away|hold"', '登记的 KR 和方向，可重复'],
      ['--change product|measure|gold', '改产品、改量法或改金标，默认 product'],
      ['--json', '输出 JSON'],
    ],
    run: (rest) => claimRegistering(rest, taskVerb('claim'), upstreamQuietly, board()),
  },
  event: {
    group: '写',
    usage: 'event <票> <类>',
    args: '[正文] [参数]',
    about: '记事件：note decision link impact ask wait resolve',
    flags: [
      ['note <正文>', '进展同步：已完成：… / 下一步：… / 卡点：…'],
      ['decision <正文>', '决策记录：决定：… 背景：… 否决方案：…'],
      ['', '--by user 是决策者定的；--kr <O / KR> 是代定且挂 KR'],
      ['link <前缀:地址>', '前缀是 pr、commit、artifact、adr'],
      ['impact', 'KR 影响声明：--o <O> --kr "<KR>=toward|away|hold"…'],
      ['', '--change product|measure|gold，默认 product'],
      ['', '纯基础设施写 --o 无'],
      ['ask <决策事项>', '上升一件待决：--kr、--context、--option（至少两次）、--rec'],
      ['', '--option 写 方案｜代价｜单向门 或 双向门'],
      ['wait <一行问题>', '等你：要决策者答一句或动手，票挂起；持票人挂会交出认领'],
      ['resolve <正文>', '已决，解除 ask 或 wait 的挂起；wait 的票指回挂起它的那个身份'],
      ['--as <身份>', '用这个身份记'],
      ['-', '正文写 - 从标准输入读'],
      ['--json', '输出 JSON'],
    ],
    run: (rest) => event(rest, upstreamQuietly, board()),
  },
  close: {
    group: '写',
    usage: 'close <票>',
    about: '关票：--done 或 --cancelled',
    flags: [
      ['--done', '做完了'],
      ['--cancelled', '作废，等它的票不再等'],
      ['--kr "<KR>=<后值> 实测|预计"', '--done 时补登记过的 KR 的结果，可重复'],
      ['--json', '输出 JSON'],
    ],
    run: taskVerb('close'),
  },
  dispatch: {
    group: '派',
    usage: 'dispatch [<票>]',
    about: '把票派给 worker',
    flags: [
      ['--brief <文本>', '目标和范围，必填'],
      ['--accept <文本>', '怎样算做完，必填'],
      ['--check <命令>', '验收写成能跑的命令，可多次；记到票上，merge 前用看板的 tasks run 跑，全过才合'],
      ['--name <名>', 'worker 名；不带票时必填，什么都不记'],
      ['--agent claude|codex|agy', '默认 claude'],
      ['--model <模型>', 'claude 默认 opus'],
      ['--to <终端>', '指派给这个终端里在跑的 worker：它空着就叫它现在领，否则做完手上那张自己领'],
      ['--new', '新开 worker，不指派给泳道里在跑的'],
      ['--json', '输出 JSON'],
    ],
    run: (rest) => dispatch(rest),
  },
  merge: { group: '派', usage: 'merge <PR>', about: '合并 PR，关票，领下一张或收掉 worker', flags: [['--wait <时长>', '领指派给你的下一张最多等多久，默认 10m'], ['--kr "<KR>=<后值> 实测|预计"', '带验收检查的票由检查关票，登记过的 KR 结果在这里报'], ['--json', '输出 JSON']], run: (rest) => merge(rest) },
  'okr-stat': { group: '少用', usage: 'okr-stat verdicts|prereg|drift', about: 'nawaban 自己 KR 的量法：声明符合率、预注册占比、账本漂移', run: (rest) => okrStat(rest, board(), DIR) },
  tell: { group: '少用', usage: 'tell <票> <一句>', about: 'worker 把「回报：<票> <一句>」发给当前编排者；没找到就记在票上', run: (rest) => tell(rest) },
  block: { group: '少用', usage: 'block <票> <挡它的票>', about: '建票之后补一条被挡', flags: [['--json', '输出 JSON']], run: taskVerb('block') },
  share: { group: '少用', usage: 'share <票>', about: '把本地建的票开成 GitHub issue，只限本机 github-sync.json 的 push 里的仓库', run: (rest) => share(rest, board(), DIR) },
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
    about: '钩子入口 renew、progress、guard、gh-account、ask-guard，不手敲',
    flags: [
      ['renew [--session <会话>]', '续租这个会话拿着的票'],
      ['progress', '从标准输入读钩子输入，记进展'],
      ['guard', '从标准输入读 PreToolUse 输入，拦下时退出 2'],
      ['gh-account', '从标准输入读 PreToolUse 输入，gh 写操作的 token 不是仓库声明的账号时拦下，退出 2'],
      ['ask-guard [--tracker old]', '从标准输入读 Stop 输入，按回复里的 ask 块记待决或打回'],
    ],
    run: ([name, ...rest]) => (name !== undefined && Object.hasOwn(HOOKS, name) ? HOOKS[name]!(rest) : Promise.resolve(misused('hook renew|progress|guard|gh-account|ask-guard|github-reply|github-state|github-impact'))),
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
  board: {
    group: '上游',
    usage: 'board <动词…>',
    about: '@vercel/board 的原生动词：nawaban board --help',
    helpIsUpstreams: true,
    run: (rest) => upstream.run(rest.length ? rest : ['--help']),
  },
}

const SESSION_FLAG = /^--session(?==|$)/
const prefixed = (words: string[]) => (rest: string[]) => [...words, ...rest]

const RENAMED: Record<string, (rest: string[]) => string[]> = {
  index: prefixed(['status']),
  inbox: prefixed(['status', '--line']),
  page: (rest) => ['status', ...rest.map((word) => word.replace(SESSION_FLAG, '--unseen'))],
  renew: prefixed(['hook', 'renew']),
  progress: prefixed(['hook', 'progress']),
  guard: prefixed(['hook', 'guard']),
  ...Object.fromEntries(UPSTREAM_VERBS.map((verb) => [verb, prefixed(['board', verb])])),
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
  '每个动词加 --help 看参数，加 --json 给机器读。',
  '少用的和本机服务：nawaban help more',
]
const MORE_HELP = screen(MORE_SCREEN)

const helpOf = (c: Command) => [`用法：nawaban ${[c.usage, c.args].filter(Boolean).join(' ')}`, c.about, ...aligned(c.flags ?? [])]

const asksForHelp = (rest: string[]) => HELP_FLAGS.has(rest[0] ?? '') || (HELP_FLAGS.has(rest.at(-1) ?? '') && !(rest.at(-2) ?? '').startsWith('-'))

const printed = (lines: string[]) => {
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function noSuchVerb(word: string) {
  process.stderr.write([`✗ 没有动词 ${word}`, ...screen(MAIN_SCREEN)].join('\n') + '\n')
  return MISUSE
}

async function runCommand(argv: string[]): Promise<number> {
  const [word, ...rest] = argv
  if (word === undefined || word === 'help' || HELP_FLAGS.has(word)) return printed(rest[0] === 'more' ? MORE_HELP : MAIN_HELP)
  if (Object.hasOwn(RENAMED, word)) {
    const renamed = RENAMED[word]!(rest)
    pointAt(renamed)
    return runCommand(renamed)
  }
  if (!Object.hasOwn(COMMANDS, word)) return noSuchVerb(word)
  const command = COMMANDS[word]!
  if (!command.helpIsUpstreams && asksForHelp(rest)) return printed(helpOf(command))
  return command.run(rest)
}

const argv = process.argv.slice(2)
const serveKeepsTheEnvironmentLaunchdGaveIt = argv[0] === 'serve'
if (!serveKeepsTheEnvironmentLaunchdGaveIt) {
  pointAtThisMachinesBoard()
  retryWhileTheBoardRestarts()
}
process.exitCode = await runCommand(argv)
