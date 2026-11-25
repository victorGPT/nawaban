import type { JSX } from '@solidjs/web'
import { Field } from '@ui-sdk/solid/field'
import { Input } from '@ui-sdk/solid/input'

export function TextField(props: { label: string; placeholder: string; value: string; onInput: (value: string) => void; disabled?: boolean; children?: JSX.Element }) {
  return (
    <Field data-kit="field" data-text-field>
      <Input data-kit="input" aria-label={props.label} placeholder={props.placeholder} value={props.value} disabled={props.disabled} maxlength={2000} onInput={(e: InputEvent) => props.onInput((e.currentTarget as HTMLInputElement).value)} />
      {props.children}
    </Field>
  )
}
