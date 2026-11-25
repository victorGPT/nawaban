import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { board, type MessageView } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, importOnlySync, pollRepo, recordRound, syncStalledNote, type Reader } from '../src/github-sync.ts'
import { recordPush } from '../src/github-sync-status.ts'
import { pushRepo, share, wantState, writeForGithub, type GithubComment, type Poster } from '../src/github-push.ts'
import { HELD_FOR_A_GITHUB_ASK, settleIssueTasks } from '../src/github-tasks.ts'
import { webAnswerText } from '../src/page.ts'
import { registerSchemas } from '../src/schemas.ts'
import { verifier } from '../src/server.ts'
import { boardData } from '../src/views.ts'

const REPO = 'acme/roubao'
const SECRET = 'webhook-secret'
const url = 'http://127.0.0.1:4999/api/board'
const yue = { id: 42, login: 'yuebutong', type: 'User' }
const owner = { id: 1, login: 'wuxianzhong-gpt', type: 'User' }
const repository = { id: 7, name: 'roubao', full_name: REPO, owner: { login: 'acme', id: 9 }, html_url: `https://github.com/${REPO}` }
const WORD: Record<string, string> = { note: '进展', ask: '待决', resolve: '已决', decision: '决定', link: 'PR', claim: '认领', release: '交还' }

let uids = 0
const asTheOldCliWritesIt = (kind: string, body: string) =>
  `${WORD[kind]}：${body}\n\n<!-- nawaban ${JSON.stringify({ v: 1, uid: `u-${++uids}`, kind, author: 'selftest', at: 1, body }).replaceAll('-', '\\u002d')} -->`

type Comment = GithubComment & { user: typeof yue; created_at: string; updated_at: string; issue_url: string; html_url: string }
type World = { bodies?: Record<number, string>; duringStateChange?: () => Promise<unknown>; open: number[]; closed?: number[]; comments: Comment[]; down: boolean; postedButNoAnswer: boolean; posts: number; reasons?: Record<number, string>; assignees?: Record<number, string[]>; opened?: { number: number; title: string; body: string }[]; openedButNoAnswer?: boolean; stateChanges?: number }
let nextComment = 9000
const commentOn = (issue: number, body: string, user = yue): Comment => {
  const at = new Date(Date.parse('2026-11-25T10:00:00Z') + nextComment * 1000).toISOString()
  return { id: ++nextComment, body, user, created_at: at, updated_at: at, issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}`, html_url: '' }
}
const issueOf = (n: number, state = 'open', w: World = world) => {
  const opened = w.opened?.find((i) => i.number === n)
  return { id: 5000 + n, number: n, title: opened?.title ?? `issue ${n}`, body: opened?.body ?? w.bodies?.[n] ?? 'x', state, state_reason: state === 'closed' ? (w.reasons?.[n] ?? 'completed') : null, user: opened ? owner : yue, labels: [], assignees: (w.assignees?.[n] ?? []).map((login) => ({ login, id: login.length, type: 'User' })), html_url: `https://github.com/${REPO}/issues/${n}`, created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:00:00Z' }
}

const readerOf = (w: World): Reader => ({
  list: async (path) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    const n = /issues\/(\d+)\/comments/.exec(path)?.[1]
    if (n) return w.comments.filter((c) => c.issue_url.endsWith(`/${n}`))
    if (path.includes('/issues/comments')) return w.comments
    return [...w.open.map((n) => issueOf(n)), ...(w.closed ?? []).map((n) => issueOf(n, 'closed'))]
  },
  one: async (path) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    const n = /issues\/(\d+)$/.exec(path)?.[1]
    return n ? { ...issueOf(Number(n), w.closed?.includes(Number(n)) ? 'closed' : 'open'), closed_by: owner } : repository
  },
  now: async () => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    return '2026-11-25T12:00:00.000Z'
  },
})

const offline = (w: World) => {
  if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
}
const posterOf = (w: World): Poster => ({
  login: owner.login,
  userId: async () => {
    offline(w)
    return owner.id
  },
  assign: async (_repo, issue, assigned) => {
    offline(w)
    const had = (w.assignees ??= {})[issue] ?? []
    w.assignees[issue] = assigned ? [...new Set([...had, owner.login])] : had.filter((l) => l !== owner.login)
  },
  setState: async (_repo, issue, wanted) => {
    offline(w)
    w.stateChanges = (w.stateChanges ?? 0) + 1
    const during = w.duringStateChange
    w.duringStateChange = undefined
    await during?.()
    w.open = w.open.filter((n) => n !== issue)
    w.closed = (w.closed ?? []).filter((n) => n !== issue)
    if (wanted === 'open') w.open.push(issue)
    else {
      w.closed.push(issue)
      ;(w.reasons ??= {})[issue] = wanted
    }
  },
  openedSince: async () => {
    offline(w)
    return (w.opened ?? []).map(({ number, body }) => ({ number, body }))
  },
  open: async (_repo, title, body) => {
    offline(w)
    const issue = { number: 1800 + (w.opened ?? []).length, title, body }
    ;(w.opened ??= []).push(issue)
    w.open.push(issue.number)
    if (w.openedButNoAnswer) throw new Error('502 Bad Gateway')
    return issue
  },
  commentsSince: async (_repo, issue) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    return w.comments.filter((c) => c.issue_url.endsWith(`/${issue}`))
  },
  post: async (_repo, issue, body) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    w.posts++
    const c = commentOn(issue, body, owner)
    w.comments.push(c)
    if (w.postedButNoAnswer) throw new Error('502 Bad Gateway')
    return c
  },
})

let team: ReturnType<typeof board>
let dir: string
let world: World

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'github-push-'))
  const sync = { github: importOnlySync({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }, 'ghp_test', SECRET) }
  team = board({ backend: local({ memory: true }), authenticate: verifier('board-secret', 'victor'), url, sync })
  world = { open: [1730], comments: [], down: false, postedButNoAnswer: false, posts: 0 }
  await poll()
})

const importDrains = () => new Promise((done) => setTimeout(done, 300))
async function poll() {
  const settle = (known: Parameters<typeof settleIssueTasks>[3]) => settleIssueTasks(team, 'roubao', REPO, known)
  await pollRepo(REPO, dir, readerOf(world), deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET), Date.now(), settle).catch(() => {})
  await importDrains()
}
const push = (now = Date.now()) => pushRepo(team, 'roubao', REPO, posterOf(world), now)
const write = (kind: string, body: string, issue = 1730) => writeForGithub(team, 'roubao', REPO, issue, asTheOldCliWritesIt(kind, body), async () => owner.login)
const replies = async (): Promise<MessageView[]> => {
  const root = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1730` } })).threads[0]!.message
  return (await team.thread(root.id)).replies.filter((r) => !r.deleted)
}
const theTask = async () => (await team.tasks.list({ channel: 'roubao', state: 'all', label: { key: 'ROUBAO-1730' } })).tasks[0]!.message
const onGithub = () => world.comments.map((c) => c.body)

describe('先写板，联网后推到 GitHub', () => {
  it('断网时写进展立刻记在板上、面板看得到；联网后 GitHub 上只多一条，原文一字不差，拉回来也不多', async () => {
    world.down = true
    const written = await write('note', '离线写的进展')
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; progress: { body: string } | null }[]).find((t) => t.id === 'ROUBAO-1730')!
    expect(row.progress?.body).toBe('离线写的进展')
    expect(await push()).toMatchObject({ unpushed: 1, error: expect.stringContaining('ENOTFOUND') })
    world.down = false
    const afterGithubWouldHaveListedAnythingSentBeforeItWentDown = Date.now() + 3 * 60_000
    expect(await push(afterGithubWouldHaveListedAnythingSentBeforeItWentDown)).toEqual({ unpushed: 0 })
    expect(onGithub()).toEqual([written.text])
    await poll()
    await poll()
    expect(await push(afterGithubWouldHaveListedAnythingSentBeforeItWentDown)).toEqual({ unpushed: 0 })
    expect(onGithub()).toHaveLength(1)
    expect((await replies()).map((r) => r.text)).toEqual([written.text])
  })

  it('不该推的不推：triage、wayfinder、lane 记账，网页答复，不带 marker 的板上回复', async () => {
    await registerSchemas(team)
    await write('note', 'triage: needs-info')
    await write('note', 'lane: sync')
    await write('note', 'wayfinder: 下一步看 -10')
    await write('note', '派给 hc t123（worktree /tmp/w，回报给 t0）\n验收：ok')
    await write('note', 'dispatch: w1 · 派给 hc t124（worktree /tmp/w，回报给 t0）\n验收：ok')
    const root = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1730` } })).threads[0]!.message
    await team.reply(root.id, webAnswerText({ option: 'A', words: '网页上答的' }))
    await team.reply(root.id, '板上随手记的')
    await write('decision', '用方案 B')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(onGithub()).toEqual([expect.stringMatching(/^决定：用方案 B/)])
  })

  it('GitHub 收下了但响应丢了：两分钟内不重推，之后按 uid 认出来，不再 POST；serve 重启也一样（记在板上的 label 里）', async () => {
    world.postedButNoAnswer = true
    await write('note', '响应丢了的那条')
    const t0 = Date.now()
    expect((await push(t0)).unpushed).toBe(1)
    world.postedButNoAnswer = false
    expect((await push(t0 + 60_000)).unpushed).toBe(1)
    expect(world.posts).toBe(1)
    expect(await push(t0 + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect(world.posts).toBe(1)
    expect(onGithub()).toHaveLength(1)
  })

  it('同一个 issue 按写的先后推，前一条推不出去，后一条也等着', async () => {
    world.postedButNoAnswer = true
    await write('ask', '上线吗')
    await write('resolve', '上')
    await push()
    expect(world.posts).toBe(1)
    expect(onGithub()).toEqual([expect.stringMatching(/^待决：上线吗/)])
  })
})

describe('GitHub 上重开过的 issue', () => {
  it('新任务的面板读得到重开后在板上先写的进展', async () => {
    world = { ...world, open: [], closed: [1730] }
    await poll()
    await poll()
    world = { ...world, open: [1730], closed: [] }
    await poll()
    await poll()
    world.down = true
    await write('note', '重开后离线写的')
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; status: string; progress: { body: string } | null }[]).find((t) => t.id === 'ROUBAO-1730' && t.status !== 'done')!
    expect(row.progress?.body).toBe('重开后离线写的')
  })
})

describe('推不出去要看得见', () => {
  it('待决提示行和面板写明还有几条没推、为什么', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    await recordRound(dir, REPO)
    await recordPush(dir, REPO, { unpushed: 2, error: '#1730：getaddrinfo ENOTFOUND api.github.com' })
    expect(await syncStalledNote(dir, 'roubao')).toBe('有 2 条还没推到 GitHub（#1730：getaddrinfo ENOTFOUND api.github.com）')
    await recordPush(dir, REPO, { unpushed: 0 })
    expect(await syncStalledNote(dir, 'roubao')).toBeNull()
  })
})

describe('板上写的待决和已决，和 GitHub 来的一起算', () => {
  it('断网时本地写待决，任务挂起；本地记已决，挂起解除，不会被下一轮挂回去', async () => {
    world.down = true
    await write('ask', '上线吗')
    await poll()
    expect((await theTask()).task?.blocked?.reason).toBe(`${HELD_FOR_A_GITHUB_ASK}上线吗`)
    await write('resolve', '上')
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
    world.down = false
    await push(Date.now() + 3 * 60_000)
    await poll()
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
  })

  it('断网时写的进展推出去之后，联网补拉回来的更早的 GitHub 评论不会盖住它', async () => {
    const earlier = commentOn(1730, '进展：同事断网期间写的')
    world.down = true
    await write('note', '我断网时写的')
    world.down = false
    await push(Date.now() + 3 * 60_000)
    world.comments.splice(0, 0, earlier)
    await poll()
    await poll()
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; progress: { body: string } | null }[]).find((t) => t.id === 'ROUBAO-1730')!
    expect(row.progress?.body).toBe('我断网时写的')
  })

  it('中间夹着板上的记账回复，排序也不乱', async () => {
    const earlier = commentOn(1730, '进展：同事断网期间写的')
    await write('note', '我写的')
    await push()
    const root = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1730` } })).threads[0]!.message
    await team.reply(root.id, 'coord: 记账')
    world.comments.splice(0, 0, earlier)
    await poll()
    await poll()
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; progress: { body: string } | null }[]).find((t) => t.id === 'ROUBAO-1730')!
    expect(row.progress?.body).toBe('我写的')
  })

  it('本地待决、已决都推出去之后，同事在 GitHub 上提新待决，网页显示并能答这一件', async () => {
    await write('ask', '上线吗')
    await write('resolve', '上')
    await push()
    world.comments.push(commentOn(1730, '待决：决策事项：换渠道吗\n关联 KR：O1\n背景：分享\n备选方案：\n- A：换｜成本\n- B：不换｜延迟\n建议：B'))
    await poll()
    await poll()
    expect((await theTask()).task?.blocked?.reason).toMatch(/换渠道吗/)
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; pending?: { ask: string | null; card: { decision: string } | null } }[]).find((t) => t.id === 'ROUBAO-1730')!
    expect(row.pending?.card?.decision).toBe('换渠道吗')
    expect(row.pending?.ask).toBeTruthy()
  })

  it('本地待决推出去之后，同事在 GitHub 上记已决，挂起解除', async () => {
    await write('ask', '上线吗')
    await push()
    await poll()
    expect((await theTask()).task?.blocked).toBeTruthy()
    world.comments.push(commentOn(1730, '已决：上'))
    await poll()
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
  })
})

describe('本地关票、认领、分享推到 GitHub', () => {
  it('断网时本地关票：板上的任务立刻关，联网后 issue 按原因关上，拉回来不重开、不多任务；再推也不多改', async () => {
    world.down = true
    await wantState(team, 'roubao', REPO, 1730, 'not_planned')
    expect((await theTask()).task?.state).toBe('canceled')
    expect((await push()).unpushed).toBe(1)
    world.down = false
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.closed).toEqual([1730])
    expect(world.reasons?.[1730]).toBe('not_planned')
    await poll()
    await poll()
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.stateChanges).toBe(1)
    const tasks = (await team.tasks.list({ channel: 'roubao', state: 'all' })).tasks
    expect(tasks.map((t) => t.message.task?.state)).toEqual(['canceled'])
  })

  it('本地关票前还有没推出去的评论，先推评论再关 issue', async () => {
    world.postedButNoAnswer = true
    await write('link', 'pr:https://github.com/acme/roubao/pull/9')
    await wantState(team, 'roubao', REPO, 1730, 'completed')
    expect((await push()).unpushed).toBe(2)
    expect(world.closed ?? []).toEqual([])
    world.postedButNoAnswer = false
    expect(await push(Date.now() + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect(world.closed).toEqual([1730])
    expect(world.reasons?.[1730]).toBe('completed')
  })

  it('GitHub 上已被同事关了，本地再关不再改 GitHub：先到的生效', async () => {
    world = { ...world, open: [], closed: [1730] }
    await poll()
    await wantState(team, 'roubao', REPO, 1730, 'not_planned')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.stateChanges ?? 0).toBe(0)
  })

  it('本地重开推到 GitHub，拉回来开一张新任务', async () => {
    world = { ...world, open: [], closed: [1730] }
    await poll()
    await poll()
    await wantState(team, 'roubao', REPO, 1730, 'open')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.open).toEqual([1730])
    await poll()
    await poll()
    expect((await theTask()).task?.state).toBe('ready')
  })

  it('本地认领：认领推出去，assignee 加上；交还时 assignee 去掉', async () => {
    await write('claim', 'selftest（hc t9）')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.assignees?.[1730]).toEqual([owner.login])
    expect(onGithub()).toEqual([expect.stringMatching(/^认领：selftest/)])
    await write('release', 'selftest')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.assignees?.[1730]).toEqual([])
  })

  it('GitHub 上已指派给别人，本地认领被拒，板上和 GitHub 都不多东西；指派给自己的账号不挡', async () => {
    world.assignees = { 1730: [yue.login] }
    await poll()
    await expect(write('claim', 'selftest')).rejects.toThrow(/已指派给 yuebutong/)
    expect(await replies()).toEqual([])
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.posts).toBe(0)
    world.assignees = { 1730: [owner.login.toUpperCase()] }
    world.comments.push(commentOn(1730, '改了指派'))
    await poll()
    await expect(write('claim', 'selftest')).resolves.toBeTruthy()
  })

  it('本地建的票分享：只开一个 issue，线程挂上去，GitHub 上的评论落在这条线程，票号变成 ROUBAO-N', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const { task } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-1', text: '本地新票\n\n要同事看的正文', labels: { key: 'ROUBAO-LOCAL-1' } })
    expect(await share(['ROUBAO-LOCAL-1'], team, dir)).toBe(0)
    expect(await share(['ROUBAO-LOCAL-1'], team, dir)).toBe(0)
    expect(await push()).toEqual({ unpushed: 0 })
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.opened).toEqual([{ number: 1800, title: '本地新票', body: expect.stringMatching(/^要同事看的正文\n\n<!-- nawaban-share /) }])
    world.comments.push(commentOn(1800, '同事：看到了'))
    await poll()
    await poll()
    const roots = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1800` } })).threads.map((t) => t.message)
    expect(roots.map((r) => r.id)).toEqual([task.id])
    expect(roots[0]!.labels.key).toBe('ROUBAO-1800')
    expect((await team.thread(task.id)).replies.map((r) => r.text)).toContain('同事：看到了')
    expect(await share(['ROUBAO-1800'], team, dir)).toBe(0)
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.opened).toHaveLength(1)
  })

  it('分享时 GitHub 开了 issue 但响应丢了：两分钟内不重开，之后按标记找回同一个，不开第二个', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const { task } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-2', text: '另一张', labels: { key: 'ROUBAO-LOCAL-2' } })
    await share(['ROUBAO-LOCAL-2'], team, dir)
    world.openedButNoAnswer = true
    const t0 = Date.now()
    expect((await push(t0)).unpushed).toBe(1)
    world.openedButNoAnswer = false
    expect((await push(t0 + 60_000)).unpushed).toBe(1)
    expect(await push(t0 + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect(world.opened).toHaveLength(1)
    expect((await team.thread(task.id, { limit: 1 })).message.labels.issue).toBe(`${REPO}#1800`)
  })

  it('关票推出去的途中又本地重开：下一轮照样把 issue 重开，不因为板上还没拉到关的状态就跳过', async () => {
    await wantState(team, 'roubao', REPO, 1730, 'completed')
    world.duringStateChange = () => wantState(team, 'roubao', REPO, 1730, 'open')
    await push()
    expect(world.closed).toEqual([1730])
    expect(await push()).toEqual({ unpushed: 0 })
    expect(world.open).toEqual([1730])
  })

  it('分享的响应丢了，重试前轮询先拉到了这个 issue：仍只有原来那条线程和那张票，重试找回同一个 issue', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const { task } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-4', text: '响应丢了的分享', labels: { key: 'ROUBAO-LOCAL-4' } })
    await share(['ROUBAO-LOCAL-4'], team, dir)
    world.openedButNoAnswer = true
    const t0 = Date.now()
    await push(t0)
    world.openedButNoAnswer = false
    world.comments.push(commentOn(1800, '同事抢先评论'))
    await poll()
    await poll()
    expect(await push(t0 + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect(world.opened).toHaveLength(1)
    const roots = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1800` } })).threads.map((t) => t.message.id)
    expect(roots).toEqual([task.id])
    expect((await team.tasks.list({ channel: 'roubao', state: 'all', label: { key: 'ROUBAO-1800' } })).tasks.map((t) => t.message.id)).toEqual([task.id])
    expect((await team.thread(task.id)).replies.map((r) => r.text)).toContain('同事抢先评论')
  })

  it('别人在 GitHub 上开的 issue 抄了分享标记，挂不走待分享的线程', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const { task } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-7', text: '待分享', labels: { key: 'ROUBAO-LOCAL-7' } })
    await share(['ROUBAO-LOCAL-7'], team, dir)
    world.openedButNoAnswer = true
    const t0 = Date.now()
    await push(t0)
    world.openedButNoAnswer = false
    world.open.push(999)
    world.bodies = { 999: `抢\n\n<!-- nawaban-share ${task.id} -->` }
    await poll()
    await poll()
    expect((await team.thread(task.id, { limit: 1 })).message.labels.issue).not.toBe(`${REPO}#999`)
    expect(await push(t0 + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect((await team.thread(task.id, { limit: 1 })).message.labels.issue).toBe(`${REPO}#1800`)
  })

  it('推送账号在分享途中改了名，按用户 ID 仍认得是自己开的', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const { task } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-8', text: '改名', labels: { key: 'ROUBAO-LOCAL-8' } })
    await share(['ROUBAO-LOCAL-8'], team, dir)
    world.openedButNoAnswer = true
    const t0 = Date.now()
    await push(t0)
    world.openedButNoAnswer = false
    const renamed = owner.login
    owner.login = 'renamed-gpt'
    try {
      await poll()
      await poll()
    } finally {
      owner.login = renamed
    }
    expect((await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1800` } })).threads.map((t) => t.message.id)).toEqual([task.id])
  })

  it('分享改了票号，子票的 parent 跟着改', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-5', text: '父票', labels: { key: 'ROUBAO-LOCAL-5' } })
    const { task: child } = await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-6', text: '子票', labels: { key: 'ROUBAO-LOCAL-6', parent: 'ROUBAO-LOCAL-5' } })
    await share(['ROUBAO-LOCAL-5'], team, dir)
    await push()
    await poll()
    await poll()
    expect((await team.thread(child.id, { limit: 1 })).message.labels.parent).toBe('ROUBAO-1800')
  })

  it('不在 push 里的项目的票分享不了', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login }))
    await team.tasks.create('roubao', { id: 'ROUBAO-LOCAL-3', text: 'x', labels: { key: 'ROUBAO-LOCAL-3' } })
    expect(await share(['ROUBAO-LOCAL-3'], team, dir)).toBe(1)
  })
})
