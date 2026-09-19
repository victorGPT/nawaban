import { expect, test } from "vitest";
import { cn } from "@/lib/utils";

// Every generated components/ui file merges classes through `cn`. A plain
// tailwind-merge reads BoardUI's composite type utilities (`text-body-medium`)
// as text colours and drops them next to a real colour, which would silently
// flatten the whole UI's typography — hence the extended merge in utils/cx.
test("cn keeps composite text styles alongside a text colour", () => {
  expect(cn("text-body-medium", "text-text-primary")).toBe("text-body-medium text-text-primary");
  expect(cn("text-caption-1-semibold", "text-body-medium")).toBe("text-body-medium");
});

test("cn resolves conflicting utilities last-write-wins and accepts clsx shapes", () => {
  expect(cn("px-2", "px-4")).toBe("px-4");
  expect(cn(["h-8", null, undefined, false], { "rounded-lg": true, "rounded-sm": false })).toBe("h-8 rounded-lg");
});

test("cn ignores function classNames, as shadcn's own cn does", () => {
  expect(cn("h-8", ((state: unknown) => String(state)) as never)).toBe("h-8");
});
