import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { inProject, nowInSeconds, read, write } from '../api'
import { ALL_PROJECTS, costOf, detailKey, inScope, preselected, projectChoices, REPLIES, waitedFor, waitingItems, waitingKey, workerOf, type ProjectReading, type Reply, type Waiting, type WaitingBoard, type WaitingOkr, type WebAnswer } from '../decide-logic'
import type { Detail } from '../detail-logic'
import { ActionRow } from '../components/ActionRow'
import { AnswerPanel } from '../components/AnswerPanel'
import { Button } from '../components/Button'
import { ChoiceKeys } from '../components/ChoiceKeys'
import { DetailPane } from '../components/DetailPane'
import { Device } from '../components/Device'
import { EmptyLine } from '../components/EmptyLine'
import { Facts } from '../components/Facts'
import { InboxList } from '../components/InboxList'
import { InboxRow } from '../components/InboxRow'
import { ListPane } from '../components/ListPane'
import { PageHead } from '../components/PageHead'
import { ProjectPicker } from '../components/ProjectPicker'
import { Prose } from '../components/Prose'
import { Question } from '../components/Question'
import { QuietLink } from '../components/QuietLink'
import { Recommendation } from '../components/Recommendation'
import { StatusLine } from '../components/StatusLine'
import { TextField } from '../components/TextField'

type ProjectRead = { name: string; at: number; board: WaitingBoard | null; failure: string; okr: WaitingOkr | null; answers: WebAnswer[]; details: Record<string, Detail> }

const NARROW = '(max-width: 760px)'
const NO_CARD_KR = /^\s*无/

async function readProject(name: string): Promise<ProjectRead> {
  const q = inProject(name)
  const [board, okr, answers] = await Promise.all([
    read<WaitingBoard>('board' + q).then((b) => [b, ''] as const, (e: Error) => [null, name + '：' + e.message] as const),
    read<WaitingOkr>('okr' + q).catch(() => null),
    read<{ answers: WebAnswer[] }>('answers' + q).then((b) => b.answers, () => [] as WebAnswer[]),
  ])
  const held = waitingItems([{ name, board: board[0], okr: null, asked: {} }])
  const fetched = await Promise.all(held.map((w) => read<Detail>('task/' + encodeURIComponent(w.id) + q).then((d) => [w.id, d] as const, () => null)))
  return { name, at: nowInSeconds(), board: board[0], failure: board[1], okr, answers, details: Object.fromEntries(fetched.filter((x) => x !== null)) }
}

export function DecidePage(props: { projects: string[]; changes: number }) {
  const [scope, setScope] = createSignal(ALL_PROJECTS)
  const [reads, setReads] = createSignal<Record<string, ProjectRead>>({})
  const [handed, setHanded] = createSignal<Record<string, WebAnswer>>({})
  const [selected, setSelected] = createSignal('')
  const [detailOpen, setDetailOpen] = createSignal(false)
  let inFlight = false
  let wanted: string[] | null = null
  const landed = (r: ProjectRead) => {
    setReads((all) => ({ ...all, [r.name]: r }))
    setHanded((all) => Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith(r.name + '/'))))
  }
  const readOnceAtATimeKeepingOnlyTheLatestAsk = (names: string[]) => {
    wanted = names
    if (inFlight) return
    inFlight = true
    const asked = wanted
    wanted = null
    Promise.all(asked.map((name) => readProject(name).then(landed))).finally(() => {
      inFlight = false
      if (wanted) readOnceAtATimeKeepingOnlyTheLatestAsk(wanted)
    })
  }
  createEffect(
    () => ({ names: props.projects, n: props.changes }),
    ({ names }) => void (names.length && readOnceAtATimeKeepingOnlyTheLatestAsk(names)),
  )
  const reading = createMemo(() => {
    const present = props.projects.map((name) => reads()[name]).filter((r): r is ProjectRead => !!r)
    if (!present.length) return null
    const readings: ProjectReading[] = present.map((p) => ({ name: p.name, board: p.board, okr: p.okr, asked: Object.fromEntries(Object.entries(p.details).map(([id, d]) => [id, d.events])) }))
    return {
      at: Math.max(...present.map((p) => p.at)),
      items: waitingItems(readings),
      details: Object.fromEntries(present.flatMap((p) => Object.entries(p.details).map(([id, d]) => [waitingKey({ project: p.name, id }), d]))),
      answers: Object.fromEntries(present.flatMap((p) => p.answers.map((a) => [waitingKey({ project: p.name, id: a.task }), a]))),
      failures: present.map((p) => p.failure).filter(Boolean),
      pending: props.projects.filter((name) => !reads()[name]),
    }
  })
  const items = createMemo(() => inScope(reading()?.items ?? [], scope()))
  const stillReading = () => {
    const pending = (reading()?.pending ?? []).filter((name) => scope() === ALL_PROJECTS || name === scope())
    return pending.length ? '还在读 ' + pending.join('、') : null
  }
  const many = () => scope() === ALL_PROJECTS && props.projects.length > 1
  const chosen = () => items().find((w) => waitingKey(w) === selected()) ?? items()[0]
  const answerOf = (w: Waiting) => handed()[detailKey(w)] ?? reading()?.answers[waitingKey(w)] ?? null
  const now = () => reading()?.at ?? nowInSeconds()
  const rowMeta = (w: Waiting) => {
    const advice = w.card?.advice
    const letter = advice && advice.choice >= 0 ? w.card!.choices[advice.choice]!.letter : ''
    return [many() ? w.project : '', costOf(w), waitedFor(w.since, now()), letter ? '建议 ' + letter : ''].filter(Boolean).join(' · ')
  }
  const picker = () => <ProjectPicker value={scope()} choices={projectChoices(props.projects, true)} onPick={setScope} />
  return (
    <Device label="待决" layout="split" detail={detailOpen()}>
      <Show when={reading()} fallback={<EmptyLine>读取中…</EmptyLine>}>
        <Show
          when={items().length}
          fallback={
            <ListPane>
              <PageHead title={stillReading() ? '读取中…' : '没有要你定的'} meta={stillReading()}>{picker()}</PageHead>
              <For each={reading()!.failures}>{(f) => <EmptyLine error>{f}</EmptyLine>}</For>
            </ListPane>
          }
        >
          <ListPane>
            <PageHead title={<><b>{items().length}</b> 件等你定</>} meta={stillReading()}>{picker()}</PageHead>
            <InboxList
              label="等你定的事"
              value={chosen() ? waitingKey(chosen()!) : ''}
              onPick={setSelected}
            >
              <For each={items()}>{(w) => <InboxRow value={waitingKey(w)} title={w.question} meta={rowMeta(w)} tone={answerOf(w) ? 'done' : 'wait'} onOpen={() => matchMedia(NARROW).matches && setDetailOpen(true)} />}</For>
            </InboxList>
            <For each={reading()!.failures}>{(f) => <EmptyLine error>{f}</EmptyLine>}</For>
          </ListPane>
          <For each={chosen() ? [detailKey(chosen()!)] : []}>
            {(key) => (
              <Show when={items().find((w) => detailKey(w) === key)}>
                {(w) => (
                  <WaitingDetail
                    item={w()}
                    detail={reading()!.details[waitingKey(w())] ?? null}
                    answer={answerOf(w())}
                    many={many()}
                    now={now()}
                    onAnswered={(a) => setHanded((all) => ({ ...all, [key]: a }))}
                    onBack={() => setDetailOpen(false)}
                  />
                )}
              </Show>
            )}
          </For>
        </Show>
      </Show>
    </Device>
  )
}

function WaitingDetail(props: { item: Waiting; detail: Detail | null; answer: WebAnswer | null; many: boolean; now: number; onAnswered: (a: WebAnswer) => void; onBack: () => void }) {
  const w = () => props.item
  const [picked, setPicked] = createSignal(preselected(props.item))
  const [draft, setDraft] = createSignal('')
  const [sending, setSending] = createSignal(false)
  const [failed, setFailed] = createSignal('')
  const worker = () => (props.detail ? workerOf(props.detail.events) : null)
  const advice = () => w().card?.advice ?? null
  const adviceLetter = () => (advice() && advice()!.choice >= 0 ? w().card!.choices[advice()!.choice]!.letter : null)
  const meta = () => [props.many ? w().project : '', w().kind === 'okr' ? '' : w().id, w().since ? '等了 ' + waitedFor(w().since, props.now) : '', costOf(w())].filter(Boolean)
  async function send(reply: Reply) {
    const ask = w().ask
    if (!ask || sending()) return
    setSending(true)
    setFailed('')
    try {
      props.onAnswered(await write<WebAnswer>('answer/' + encodeURIComponent(w().id) + inProject(w().project), { ask, ...reply }))
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const pickedChoice = () => w().card?.choices.find((c) => c.letter === picked())
  return (
    <DetailPane onBack={props.onBack}>
      <Question text={w().question} meta={meta()} />
      <Show
        when={!props.answer}
        fallback={
          <StatusLine tone={props.answer!.heard ? 'done' : 'stopped'}>
            {props.answer!.heard ? '已交编排者' : '已记在票上，编排者不在线'}
            {props.answer!.option ? '：选「' + props.answer!.option + '」' : '：' + props.answer!.words}
          </StatusLine>
        }
      >
        <Show when={w().card}>
          {(card) => (
            <AnswerPanel>
              <Show when={advice()}>{(a) => <Recommendation letter={adviceLetter()} why={a().why} model={worker()?.model} />}</Show>
              <ChoiceKeys label="选一项" choices={card().choices} value={picked()} onPick={setPicked} disabled={sending()} />
              <ActionRow>
                <Button tone="primary" disabled={!pickedChoice() || sending()} onClick={() => send(REPLIES.pick(pickedChoice()!.sent))}>
                  {pickedChoice() ? '就这么定 ' + picked() : '先选一项'}
                </Button>
                <Button disabled={sending()} onClick={() => send(REPLIES.unclear)}>背景不够，退回</Button>
              </ActionRow>
            </AnswerPanel>
          )}
        </Show>
        <Show when={w().kind === 'ask' && w().ask}>
          <AnswerPanel>
            <TextField label="回一句" placeholder="回一句" value={draft()} onValueChange={setDraft} disabled={sending()}>
              <Button tone="primary" disabled={!draft().trim() || sending()} onClick={() => send(REPLIES.say(draft().trim()))}>发给编排者</Button>
            </TextField>
            <QuietLink onClick={() => send(REPLIES.needsOptions)}>没法回一句？让编排者补成选项</QuietLink>
          </AnswerPanel>
        </Show>
        <Show when={sending()}>
          <StatusLine tone="working">正在交给编排者…</StatusLine>
        </Show>
        <Show when={failed()}>{(why) => <EmptyLine error>没交上：{why()}</EmptyLine>}</Show>
      </Show>
      <Facts
        rows={[
          w().card && ['背景', <Prose text={w().card!.context} clamp />],
          w().card && !NO_CARD_KR.test(w().card!.kr) && ['KR', <Prose text={w().card!.kr} />],
          w().readings.length > 0 && ['读数', <ul><For each={w().readings}>{(r) => <li>{r.name}<em>{r.reading}</em></li>}</For></ul>],
          w().waitsOnThis.length > 0 && ['在等它', <ul><For each={w().waitsOnThis}>{(t) => <li><code>{t.id}</code>{t.title}<em>{t.state}</em></li>}</For></ul>],
          !!props.detail?.blocked_by.some((b) => b.status !== 'done') && ['它在等', <ul><For each={props.detail!.blocked_by.filter((b) => b.status !== 'done')}>{(t) => <li><code>{t.id}</code>{t.title}</li>}</For></ul>],
          props.detail?.latest_note && ['最新进展', <Prose text={props.detail.latest_note.body} clamp />],
          !!props.detail?.links.length && ['链接', <ul><For each={props.detail!.links.map((l) => l.body.replace(/^\w+:/, ''))}>{(u) => <li>{/^https?:\/\//.test(u) ? <a href={u} target="_blank" rel="noreferrer">{u.replace(/^https:\/\/github\.com\/[^/]+\//, '')}</a> : u}</li>}</For></ul>],
          worker() && ['谁在做', <p>{worker()!.name}<Show when={worker()!.agent || worker()!.model}><em>{[worker()!.agent, worker()!.model].filter(Boolean).join(' · ')}</em></Show></p>],
        ]}
      />
    </DetailPane>
  )
}
