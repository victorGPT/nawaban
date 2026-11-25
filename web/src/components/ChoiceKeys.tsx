import { For } from 'solid-js'
import { Radio, RadioGroup } from '@ui-sdk/solid/radio'

export type ChoiceKey = { letter: string; text: string; cost: string }

export function ChoiceKeys(props: { label: string; choices: ChoiceKey[]; value: string; onPick: (letter: string) => void; disabled?: boolean }) {
  return (
    <RadioGroup data-kit="radio-group" data-choice-keys aria-label={props.label} value={props.value} onValueChange={(v) => props.onPick(String(v ?? ''))} disabled={props.disabled}>
      <For each={props.choices}>
        {(c) => (
          <label data-kit="check" data-value={c.letter}>
            <Radio value={c.letter} data-kit="button" data-tone="secondary" data-shape="round" aria-label={c.letter}>
              <span data-kit="record-dot" data-off={props.value !== c.letter || undefined} aria-hidden="true" />
            </Radio>
            <span data-choice>
              <span data-choice-text>
                <b>{c.letter}</b>
                {c.text}
              </span>
              <span data-choice-cost>{c.cost}</span>
            </span>
          </label>
        )}
      </For>
    </RadioGroup>
  )
}
