import type { board } from '@vercel/board'

const text = { type: 'string', minLength: 1 } as const
const basis = { enum: ['实测', '预计'] } as const

const UNCHANGED_KR_MAY_CARRY_A_READING_NOTHING_JUDGES = {
  type: 'object',
  required: ['name', 'dir'],
  additionalProperties: false,
  properties: { name: text, dir: { enum: ['='] }, before: text, after: text, basis },
} as const

const MOVED_KR_WITH_ITS_READING_BEFORE_AND_AFTER = {
  type: 'object',
  required: ['name', 'dir', 'before', 'after', 'basis'],
  additionalProperties: false,
  properties: { name: text, dir: { enum: ['↑', '↓'] }, before: text, after: text, basis },
} as const

const VERSIONS_NEVER_EDITED_ONCE_A_BOARD_HAS_THEM_ONLY_ADDED_AND_READ_ALIKE = {
  'nawaban-decision@1': {
    description: 'A choice taken on a task: the question, the verdict, what was turned down, and who took it.',
    schema: {
      type: 'object',
      required: ['question', 'verdict', 'rejected', 'by'],
      additionalProperties: false,
      properties: { question: text, verdict: text, rejected: { type: 'array', items: text }, by: { enum: ['agent', 'user'] }, kr: text },
    },
  },
  'nawaban-link@1': {
    description: 'What a task produced, elsewhere: a pull request, a commit, an artifact, an ADR.',
    schema: {
      type: 'object',
      required: ['kind', 'ref'],
      additionalProperties: false,
      properties: { kind: { enum: ['pr', 'commit', 'artifact', 'adr'] }, ref: text },
    },
  },
  'nawaban-ask@1': {
    description: "A decision card for the decision-maker: what's to decide, the KR it serves, the facts, two options or more, and a recommendation.",
    schema: {
      type: 'object',
      required: ['decision', 'kr', 'context', 'options', 'recommendation'],
      additionalProperties: false,
      properties: {
        decision: text,
        kr: text,
        context: text,
        options: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            required: ['choice', 'tradeoff', 'door'],
            additionalProperties: false,
            properties: { choice: text, tradeoff: text, door: { enum: ['one-way', 'two-way'] } },
          },
        },
        recommendation: text,
      },
    },
  },
  'nawaban-resolve@1': {
    description: "The decision-maker's answer to a task's decision card, in their words.",
    schema: { type: 'object', required: ['words'], additionalProperties: false, properties: { words: text } },
  },
  'nawaban-impact@1': {
    description:
      'Which KRs of one Objective a task moves: each up or down with its value before and after and whether that was measured or expected, or unchanged. Objective 无 with no KRs is pure infrastructure.',
    schema: {
      type: 'object',
      required: ['objective', 'krs'],
      additionalProperties: false,
      properties: {
        objective: text,
        krs: {
          type: 'array',
          items: {
            oneOf: [
              UNCHANGED_KR_MAY_CARRY_A_READING_NOTHING_JUDGES,
              MOVED_KR_WITH_ITS_READING_BEFORE_AND_AFTER,
            ],
          },
        },
      },
    },
  },
  'nawaban-kr-reading@1': {
    description:
      "One KR's reading as its measure printed it: the value verbatim, the as-of date and what it was read from, with the okr.toml commit it was measured under. The message's time is its round.",
    schema: {
      type: 'object',
      required: ['kr', 'value', 'as_of', 'source'],
      additionalProperties: false,
      properties: { objective: text, kr: text, value: text, as_of: text, source: { type: 'string' }, commit: text },
    },
  },
  'nawaban-okr-accept@1': {
    description: "The decision-maker's sign-off on an Objective whose KRs were all met when it was given; the message's time is when.",
    schema: { type: 'object', required: ['objective'], additionalProperties: false, properties: { objective: text } },
  },
  'nawaban-web-answer@1': {
    description:
      "The decision-maker's answer to a task's hold, written on the web page: the option they picked, if any, and their words. It lifts no hold; the orchestrator checks it and records the resolve.",
    schema: { type: 'object', required: ['words'], additionalProperties: false, properties: { option: text, words: text } },
  },
  'nawaban-inbox@1': {
    description: "An idea the decision-maker jotted on the web page, for the orchestrator to make a task or a command of. The thread's inbox label says whether it is still open.",
    schema: { type: 'object', required: ['words'], additionalProperties: false, properties: { words: text } },
  },
  'nawaban-dispatch@1': {
    description: 'A task handed to a worker: who, in which terminal, and what counts as done.',
    schema: {
      type: 'object',
      required: ['worker', 'terminal', 'accept'],
      additionalProperties: false,
      properties: { worker: text, terminal: text, accept: text },
    },
  },
} as const
export const SCHEMAS = VERSIONS_NEVER_EDITED_ONCE_A_BOARD_HAS_THEM_ONLY_ADDED_AND_READ_ALIKE

const MIN_DECISION_OPTIONS = 2
const WORDS_THAT_SAY_NOTHING = new Set(['', '无', 'none', '-'])
const saysNothing = (v: unknown) => WORDS_THAT_SAY_NOTHING.has(String(v ?? '').trim().toLowerCase())
const blank = (v: unknown) => !String(v ?? '').trim()

export type DecisionCard = {
  decision?: unknown
  kr?: unknown
  context?: unknown
  options?: { choice?: unknown; tradeoff?: unknown; door?: unknown }[]
  recommendation?: unknown
}

export function gapsOfADecisionCard(c: DecisionCard): string[] {
  const options = c.options ?? []
  return [
    ...(saysNothing(c.decision) ? ['决策事项 (--body)'] : []),
    ...(blank(c.kr) ? ['关联 KR (--kr)'] : []),
    ...(saysNothing(c.context) ? ['背景 (--context)'] : []),
    ...(options.length < MIN_DECISION_OPTIONS ? [`备选方案 (--option，至少 ${MIN_DECISION_OPTIONS} 条)`] : []),
    ...options.flatMap((o, i) => [...(blank(o.choice) ? [`第 ${i + 1} 条的方案`] : []), ...(saysNothing(o.tradeoff) ? [`第 ${i + 1} 条的代价`] : [])]),
    ...(saysNothing(c.recommendation) ? ['建议 (--rec)'] : []),
  ]
}

export type SchemaId = keyof typeof SCHEMAS

export async function registerSchemas(team: ReturnType<typeof board>) {
  for (const [id, { description, schema }] of Object.entries(SCHEMAS)) {
    const [name, version] = id.split('@')
    await team.createSchema({ name: name!, version: Number(version), description, schema })
  }
}
