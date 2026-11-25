import { omit } from 'solid-js'
import { Button as SdkButton } from '@ui-sdk/solid/button'
import type { ComponentProps } from 'solid-js'

type Tone = 'primary' | 'secondary'

export function Button(props: ComponentProps<typeof SdkButton> & { tone?: Tone; round?: boolean }) {
  const rest = omit(props, 'tone', 'round')
  return <SdkButton data-kit="button" data-tone={props.tone ?? 'secondary'} data-shape={props.round ? 'round' : undefined} {...rest} />
}
