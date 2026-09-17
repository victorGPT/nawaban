"use client";

import type { ReactNode, Ref, HTMLAttributes } from "react";
import { Field } from "@base-ui/react/field";
import { cx } from "@/utils/cx";

/** Field description, also announced when styled as an error hint. */

export interface HintTextProps extends HTMLAttributes<HTMLParagraphElement> {
  children: ReactNode;
  isInvalid?: boolean;
  ref?: Ref<HTMLParagraphElement>;
}

export function HintText({
  isInvalid = false,
  className,
  ...props
}: HintTextProps) {
  return (
    <Field.Description
      {...props}
      className={cx(
        "pt-px text-caption-1-medium text-text-secondary",
        isInvalid && "text-text-error-primary",
        className,
      )}
    />
  );
}
