import { useLocale } from "@/i18n";
import type { Capture } from "@/lib/types";

export function CaptureSource({ item }: { item: Capture }) {
  useLocale();
  return <div className="flex flex-col gap-2">
    <code className="text-caption-1-regular text-text-tertiary">{item.id}</code>
    <p className="whitespace-pre-wrap break-words text-body-regular text-text-primary">{item.content}</p>
  </div>;
}
