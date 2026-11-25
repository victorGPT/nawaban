import type { JSX } from '@solidjs/web'
import { Field } from '@ui-sdk/solid/field'
import { Textarea } from '@ui-sdk/solid/textarea'

export function TextArea(props: { label: string; placeholder: string; value: string; onValueChange: (value: string) => void; disabled?: boolean; children?: JSX.Element }) {
  return (
    <Field data-kit="field" data-text-area>
      <Textarea data-kit="input" data-multiline="" aria-label={props.label} placeholder={props.placeholder} rows={3} value={props.value} disabled={props.disabled} maxlength={2000} onValueChange={(v: string) => props.onValueChange(v)} />
      {props.children}
    </Field>
  )
}
