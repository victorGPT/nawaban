const OLD_CARD_FIELD = /^\s*【(Decision|Objective \/ KR|Context|Options|Recommendation)】(.*)/
const DR_FIELD = /^\s*(决策事项|关联\s*KR|背景|备选方案|建议)\s*[:：](.*)/
const ENGLISH_DR_FIELD = /^\s*(BLUF|KR|Context|Options|Recommendation)\s*[:：](.*)/
const CARD_FIELD_SYNTAXES = [OLD_CARD_FIELD, DR_FIELD, ENGLISH_DR_FIELD]
const CARD_OPTION_LINE = /^\s*[-*]\s+(.*)/
const CARD_OPTION_LETTER = /^([A-Z])\s*[：:]\s*/
const CARD_OPTION_NOTE = '｜'
const OPTIONS = 'Options'
const CARD_FIELD_KEYS: Record<string, string> = {
  Decision: 'decision', BLUF: 'decision', 决策事项: 'decision', 'Objective / KR': 'kr', KR: 'kr',
  Context: 'context', 背景: 'context', Recommendation: 'rec', 建议: 'rec', 备选方案: OPTIONS,
}
const PENDING_HEADING = /^\s*(?:#{1,6}\s*)?\**(?:待决|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]\**\s*/
const WORDS_THAT_SAY_NOTHING = new Set(['', '-', '--', '—', '——', '无', '暂无', '待定', '未定', '略', 'none', 'n/a', 'null', 'tbd', 'todo', '?', '？', '...', '…'])
const SPACES_A_PLACEHOLDER_MAY_CARRY = /[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g
const MIN_DECISION_OPTIONS = 2

type Option = { key: string; text: string; note: string }
export type GithubCard = { decision: string; kr: string; context: string; options: Option[]; rec: string }

const saysNothing = (part: string | undefined) => WORDS_THAT_SAY_NOTHING.has((part ?? '').replace(SPACES_A_PLACEHOLDER_MAY_CARRY, '').toLowerCase())
const tradeOffOf = (option: Option) => option.note.split(CARD_OPTION_NOTE)[0]!.trim()

function cardOption(line: string, position: number): Option {
  const lettered = CARD_OPTION_LETTER.exec(line)
  const rest = line.slice(lettered ? lettered[0].length : 0)
  const at = rest.indexOf(CARD_OPTION_NOTE)
  const [text, note] = at < 0 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 1)]
  return { key: lettered ? lettered[1]! : `第 ${position + 1} 项`, text: text.trim(), note: note.trim() }
}

export function cardFromAGithubAsk(brief: string): GithubCard | null {
  const fields: Record<string, string> = {}
  const options: Option[] = []
  let current: string | null = null
  const lines = brief.replace(PENDING_HEADING, '').split(/\r?\n/)
  const oneSyntaxPerCard = CARD_FIELD_SYNTAXES.find((s) => lines.some((l) => s.test(l))) ?? DR_FIELD
  for (const line of lines) {
    const option: RegExpExecArray | null = current === OPTIONS ? CARD_OPTION_LINE.exec(line) : null
    const field: RegExpExecArray | null = option ? null : oneSyntaxPerCard.exec(line)
    if (option) options.push(cardOption(option[1]!.trim(), options.length))
    else if (field) {
      const name: string = field[1]!.replace(/关联\s*KR/, 'KR')
      const key: string = CARD_FIELD_KEYS[name] ?? name
      current = key
      if (key !== OPTIONS) fields[key] = field[2]!.trim()
    } else if (current !== null && current in fields) fields[current] = [fields[current], line.trim()].filter(Boolean).join('\n')
  }
  const gaps = [saysNothing(fields.decision), saysNothing(fields.context), saysNothing(fields.rec), !(fields.kr ?? '').trim(), options.length < MIN_DECISION_OPTIONS, options.some((o) => saysNothing(o.text) || saysNothing(tradeOffOf(o)))]
  return gaps.some(Boolean) ? null : { decision: fields.decision!, kr: fields.kr!, context: fields.context!, options, rec: fields.rec! }
}
