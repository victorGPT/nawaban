"use client";

import type { ReactNode, Ref } from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { mergeProps } from "@base-ui/react/merge-props";
import { useControlState } from "../input/use-control-state";
import { cx } from "@/utils/cx";
import { CheckboxGlyph, checkboxSizes } from "./checkbox-glyph";
import type { CheckboxSize } from "./checkbox-glyph";

/**
 * Figma source: Board UI → Checkbox (node 3699:2557 family; used in
 * dashboard 1 table, nodes 3731:3258 etc.).
 *
 * radius/sm (4px). Two sizes:
 *   md  16×16, label Body 1/Medium (14)
 *   sm  14×14, label Body 2/Medium (13)
 *
 * States (per Figma):
 *   default        bg background/primary/default, 1px border/checkbox/default,
 *                  shadow/xs
 *   hover          border darkens to neutral/400
 *   checked /      Button/Primary gradient (blue/500 → blue/600) with the
 *   indeterminate  checkbox inner highlight (see --shadow-checkbox-selected),
 *                  white 2px rounded stroke glyph; on hover the gradient
 *                  lightens to blue/400 → blue/500
 *
 * Built on Base UI Checkbox: keyboard toggling, aria-checked="mixed" for
 * indeterminate, label association when `children` is passed.
 */

interface CheckboxState {
  isSelected: boolean;
  isIndeterminate: boolean;
  isDisabled: boolean;
  isReadOnly: boolean;
  isRequired: boolean;
  isInvalid: boolean;
  isFocusVisible: boolean;
  isHovered: boolean;
}

export interface CheckboxProps extends Omit<BaseCheckbox.Root.Props, "children" | "className" | "onChange"> {
  children?: ReactNode;
  className?: string | ((state: CheckboxState) => string);
  size?: CheckboxSize;
  ref?: Ref<HTMLLabelElement>;
  isSelected?: boolean;
  defaultSelected?: boolean;
  isIndeterminate?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  onChange?: (selected: boolean) => void;
}

export function Checkbox({ className, children, size = "md", ref, isSelected, defaultSelected,
  isIndeterminate, isDisabled, isReadOnly, isRequired, isInvalid, onChange, ...props }: CheckboxProps) {
  const s = checkboxSizes[size];
  const { interactionProps, ...interaction } = useControlState();
  return (
    <BaseCheckbox.Root
      {...mergeProps(interactionProps, props)}
      ref={ref}
      checked={isSelected ?? props.checked}
      defaultChecked={defaultSelected ?? props.defaultChecked}
      indeterminate={isIndeterminate ?? props.indeterminate}
      disabled={isDisabled ?? props.disabled}
      readOnly={isReadOnly ?? props.readOnly}
      required={isRequired ?? props.required}
      aria-invalid={isInvalid || props["aria-invalid"] || undefined}
      onCheckedChange={(checked, details) => { onChange?.(checked); props.onCheckedChange?.(checked, details); }}
      render={(rootProps, state) => {
        const visual = { ...interaction, isSelected: state.checked, isIndeterminate: state.indeterminate,
          isDisabled: state.disabled, isReadOnly: state.readOnly, isRequired: state.required, isInvalid: !!isInvalid };
        return (
          <label {...rootProps} className={cx(rootProps.className, "group inline-flex items-center select-none", s.gap,
            state.disabled ? "cursor-not-allowed" : "cursor-pointer",
            typeof className === "function" ? className(visual) : className)}>
            <CheckboxGlyph state={visual} size={size} />
            {children != null && <span className={cx(s.label, "text-text-primary")}>{children}</span>}
          </label>
        );
      }}
    />
  );
}
