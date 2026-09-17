import { useState } from "react";

/** Visual state only; Base UI owns focus movement and activation. */
export function useControlState() {
  const [isHovered, setHovered] = useState(false);
  const [isFocusVisible, setFocusVisible] = useState(false);
  return {
    isHovered,
    isFocusVisible,
    interactionProps: {
      onPointerDown: () => setFocusVisible(false),
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (!event.altKey && !event.ctrlKey && !event.metaKey) setFocusVisible(true);
      },
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
      onFocus: (event: React.FocusEvent<HTMLElement>) => setFocusVisible(event.currentTarget.matches(":focus-visible")),
      onBlur: () => setFocusVisible(false),
    },
  };
}
