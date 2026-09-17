"use client";

import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
  type Ref,
  type InputHTMLAttributes,
} from "react";
import { Field } from "@base-ui/react/field";
import { Input as BaseInput } from "@base-ui/react/input";
import { Label } from "./label";
import { HintText } from "./hint-text";
import { cx, sortCx } from "@/utils/cx";

/** BoardUI field visuals with Base UI label, description and control semantics. */

export type InputSize = "medium" | "small";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/* -------------------------------------------------------------------------- */
/*  TextFieldContext                                                           */
/* -------------------------------------------------------------------------- */

export interface TextFieldContextValue {
  size?: InputSize;
  fieldClassName?: string;
  inputClassName?: string;
  controlProps?: InputHTMLAttributes<HTMLInputElement>;
  onValueChange?: (value: string) => void;
}

/**
 * Shared by every field that wants Input's shell — `Textarea` reads the same
 * size and class overrides out of it, so a composed form stays consistent.
 */
export const TextFieldContext = createContext<TextFieldContextValue>({});

/* -------------------------------------------------------------------------- */
/*  TextField                                                                  */
/* -------------------------------------------------------------------------- */

type FieldState = { isRequired: boolean; isInvalid: boolean; isDisabled: boolean; isReadOnly: boolean };

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "className" | "children" | "onChange" | "value" | "defaultValue">,
    Pick<TextFieldContextValue, "size" | "fieldClassName" | "inputClassName"> {
  className?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  isRequired?: boolean;
  isInvalid?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  children?: ReactNode | ((state: FieldState) => ReactNode);
}

export function TextField({
  size = "medium", fieldClassName, inputClassName, className, children,
  isRequired = false, isInvalid = false, isDisabled = false, isReadOnly = false,
  onChange, ...props
}: TextFieldProps) {
  const state = {
    isRequired: isRequired || !!props.required,
    isInvalid: isInvalid || props["aria-invalid"] === true || props["aria-invalid"] === "true",
    isDisabled: isDisabled || !!props.disabled,
    isReadOnly: isReadOnly || !!props.readOnly,
  };
  const controlProps = {
    ...props, required: state.isRequired, disabled: state.isDisabled, readOnly: state.isReadOnly,
  };
  return (
    <TextFieldContext.Provider value={{ size, fieldClassName, inputClassName, controlProps, onValueChange: onChange }}>
      <Field.Root
        disabled={state.isDisabled}
        invalid={state.isInvalid}
        name={props.name}
        data-input-size={size}
        className={cx("group flex h-max w-full flex-col items-start gap-1", className)}
      >
        {typeof children === "function" ? children(state) : children}
      </Field.Root>
    </TextFieldContext.Provider>
  );
}

TextField.displayName = "TextField";

/* -------------------------------------------------------------------------- */
/*  InputBase                                                                  */
/* -------------------------------------------------------------------------- */

export interface InputBaseProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "className"> {
  size?: InputSize;
  className?: string;
  leadingIcon?: IconComponent;
  trailingIcon?: IconComponent;
  /** Custom element rendered in the leading slot (Phone basic uses this). */
  leadingAddon?: ReactNode;
  /** Class for the field shell. */
  fieldClassName?: string;
  /** Ref to the <input> element. */
  ref?: Ref<HTMLInputElement>;
  /** Ref to the field shell wrapper. */
  groupRef?: Ref<HTMLDivElement>;
}

const inputStyles = sortCx({
  field: [
    "relative flex w-full items-center",
    "rounded-2lg",
    "bg-background-tertiary-default text-foreground-icon-tertiary",
    "ring-2 ring-inset ring-transparent",
    "transition-[background-color,box-shadow,color] duration-[var(--input-transition-ms)] ease",
  ].join(" "),

  fieldSize: {
    medium: "p-2",                // 8px all sides → h auto = 36
    small:  "h-8 px-1.5 py-2",    // 32 / 6 / 8
  },

  // When a leadingAddon is present (Phone basic): tighten left padding.
  fieldWithAddonSize: {
    medium: "h-9 pl-1 pr-2 py-2", // 36 / 4 / 8 / 8
    small:  "h-8 pl-1 pr-1.5 py-2",
  },

  content: "flex w-full items-center gap-2 min-w-0",
  leftSection: "flex flex-1 items-center gap-0.5 min-w-0",

  input: [
    "min-w-0 flex-1 bg-transparent border-0 outline-none p-0 m-0",
    "font-sans text-body-regular text-text-primary pl-1",
    "placeholder:text-text-tertiary",
    "focus:placeholder:text-text-primary",
    "disabled:text-input-disabled-text disabled:placeholder:text-input-disabled-text",
    "disabled:cursor-not-allowed",
    "aria-invalid:placeholder:text-text-error-placeholder",
  ].join(" "),

  icon: "size-5 shrink-0",
});

export function InputBase({
  size: sizeProp,
  leadingIcon: Leading,
  trailingIcon: Trailing,
  leadingAddon,
  fieldClassName,
  className,
  ref,
  groupRef,
  ...inputProps
}: InputBaseProps) {
  const ctx = useContext(TextFieldContext);
  const size: InputSize = sizeProp ?? ctx.size ?? "medium";
  const hasAddon = leadingAddon !== undefined && leadingAddon !== null;

  return (
    <div
      ref={groupRef}
      className={cx(
        inputStyles.field,
        hasAddon ? inputStyles.fieldWithAddonSize[size] : inputStyles.fieldSize[size],
        "hover:ring-border-button-hover focus-within:ring-border-button-active",
        "has-[:disabled]:bg-input-disabled-background has-[:disabled]:text-input-disabled-foreground has-[:disabled]:ring-transparent",
        "has-[[aria-invalid=true]]:bg-background-tertiary-error has-[[aria-invalid=true]]:text-foreground-icon-error has-[[aria-invalid=true]]:ring-transparent",
        ctx.fieldClassName,
        fieldClassName,
      )}
    >
      <div className={inputStyles.content}>
        <div className={inputStyles.leftSection}>
          {hasAddon ? (
            leadingAddon
          ) : Leading ? (
            <Leading className={inputStyles.icon} aria-hidden />
          ) : null}
          <BaseInput
            ref={ref}
            {...ctx.controlProps}
            {...inputProps}
            onValueChange={ctx.onValueChange}
            className={cx(inputStyles.input, ctx.inputClassName, className)}
          />
        </div>
        {Trailing ? (
          <Trailing className={inputStyles.icon} aria-hidden />
        ) : null}
      </div>
    </div>
  );
}

InputBase.displayName = "InputBase";

/* -------------------------------------------------------------------------- */
/*  Input (composed)                                                           */
/* -------------------------------------------------------------------------- */

export interface InputProps
  extends Omit<TextFieldProps, "children">,
    Pick<
      InputBaseProps,
      | "leadingIcon"
      | "trailingIcon"
      | "leadingAddon"
      | "fieldClassName"
      | "groupRef"
      | "ref"
    > {
  label?: ReactNode;
  hint?: ReactNode;
  /** Show an info icon next to the label. Replace with tooltip when Tooltip lands. */
  tooltip?: boolean | string;
  placeholder?: string;
}

export function Input({
  label,
  hint,
  tooltip,
  placeholder,
  leadingIcon,
  trailingIcon,
  leadingAddon,
  fieldClassName,
  ref,
  groupRef,
  className,
  ...textFieldProps
}: InputProps) {
  return (
    <TextField
      {...textFieldProps}
      className={className}
      // Don't clobber an explicit aria-label; fall back to the placeholder
      // only for unlabelled fields that don't provide one.
      aria-label={
        textFieldProps["aria-label"] ??
        (!label && typeof placeholder === "string" ? placeholder : undefined)
      }
    >
      {({ isRequired, isInvalid }) => (
        <>
          {label && (
            <Label
              isRequired={isRequired}
              isInvalid={isInvalid}
              tooltip={tooltip}
            >
              {label}
            </Label>
          )}
          <InputBase
            ref={ref}
            groupRef={groupRef}
            placeholder={placeholder}
            leadingIcon={leadingIcon}
            trailingIcon={trailingIcon}
            leadingAddon={leadingAddon}
            fieldClassName={fieldClassName}
          />
          {hint && <HintText isInvalid={isInvalid}>{hint}</HintText>}
        </>
      )}
    </TextField>
  );
}

Input.displayName = "Input";
