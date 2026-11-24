import { expect, it } from 'vitest'
import { cardFromAGithubAsk } from '../src/github-card.ts'

const full = ['决策事项：上线吗', '关联 KR：O1', '背景：发布渠道', '备选方案：', '- A：上｜承担成本', '- B：不上｜延迟收益', '建议：B']

it('读出旧 CLI 读得出的决策卡：字段、选项字母、代价', () => {
  expect(cardFromAGithubAsk(['待决：' + full[0], ...full.slice(1)].join('\n'))).toEqual({
    decision: '上线吗', kr: 'O1', context: '发布渠道', rec: 'B',
    options: [{ key: 'A', text: '上', note: '承担成本' }, { key: 'B', text: '不上', note: '延迟收益' }],
  })
})

it('写法按第一行能认出的字段定，后面混进别的写法也不影响', () => {
  expect(cardFromAGithubAsk([...full, '【Context】补充说明'].join('\n'))?.decision).toBe('上线吗')
})

it('缺项、占位、少于两个方案的不算卡', () => {
  expect(cardFromAGithubAsk(full.filter((l) => !l.startsWith('关联')).join('\n'))).toBeNull()
  expect(cardFromAGithubAsk(full.map((l) => (l.startsWith('背景') ? '背景：无' : l)).join('\n'))).toBeNull()
  expect(cardFromAGithubAsk(full.filter((l) => !l.startsWith('- B')).join('\n'))).toBeNull()
})
