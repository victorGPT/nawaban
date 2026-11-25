const GLYPHS = {
  'chevron-down': 'M8 11 3 6 3.7 5.3 8 9.6 12.3 5.3 13 6z',
  prev: 'M5 8 10 3 10.7 3.7 6.4 8 10.7 12.3 10 13z',
}

export type IconName = keyof typeof GLYPHS

export function Icon(props: { name: IconName }) {
  return (
    <span data-kit="icon" data-icon={props.name} aria-hidden="true">
      <svg preserveAspectRatio="xMidYMid meet" fill="currentColor" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <path d={GLYPHS[props.name]} />
      </svg>
    </span>
  )
}
