import type { board } from '@vercel/board'

const text = { type: 'string', minLength: 1 } as const

/**
 * nawaban's own blocks. A version never changes once a board has it (docs/04-reference/02-board.md,
 * createSchema): a change is the next version, and readers take both.
 */
export const SCHEMAS = {
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
              { type: 'object', required: ['name', 'dir'], additionalProperties: false, properties: { name: text, dir: { enum: ['='] } } },
              {
                type: 'object',
                required: ['name', 'dir', 'before', 'after', 'basis'],
                additionalProperties: false,
                properties: { name: text, dir: { enum: ['↑', '↓'] }, before: text, after: text, basis: { enum: ['实测', '预计'] } },
              },
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

export type SchemaId = keyof typeof SCHEMAS

/** Registers every schema; one already there with the same definition is left as it is. */
export async function registerSchemas(team: ReturnType<typeof board>) {
  for (const [id, { description, schema }] of Object.entries(SCHEMAS)) {
    const [name, version] = id.split('@')
    await team.createSchema({ name: name!, version: Number(version), description, schema })
  }
}
