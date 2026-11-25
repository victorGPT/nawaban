import type { JSX } from '@solidjs/web'
import { Button } from './Button'
import { Icon } from './Icon'

export function DetailPane(props: { onBack?: () => void; children: JSX.Element }) {
  return (
    <article data-detail-pane>
      <div data-back-key>
        <Button round aria-label="回到列表" onClick={() => props.onBack?.()}>
          <Icon name="prev" />
        </Button>
      </div>
      {props.children}
    </article>
  )
}
