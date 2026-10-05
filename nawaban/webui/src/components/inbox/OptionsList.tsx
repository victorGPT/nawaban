import { t, useLocale } from "@/i18n";
import { Md } from "@/components/Md";
import { Surface } from "@/components/NawabanUI";
import { RadioGroup } from "@/components/ui/radio-group";
import { RadioCard } from "@/components/application/radio/radio-card";

export type OptionItem = { option: string; consequence?: string };

// Shared option presentation; onSelect enables interactive selection.
export function OptionsList({
  options,
  selectedIndex,
  onSelect,
}: {
  options: OptionItem[];
  selectedIndex?: number | null;
  onSelect?: (i: number) => void;
}) {
  useLocale();
  if (onSelect)
    return (
      <RadioGroup
        aria-label={t("decisionOptions")}
        value={selectedIndex == null ? "" : String(selectedIndex)}
        onValueChange={(value) => onSelect(Number(value))}
        className="decision-options"
      >
        {options.map((o, i) => (
          <RadioCard
            key={i}
            value={String(i)}
            title={<Md text={o.option} />}
            description={o.consequence && <Md text={o.consequence} />}
          />
        ))}
      </RadioGroup>
    );
  return (
    <div className="decision-options">
      {options.map((o, i) => (
        <Surface className="inbox-option" key={i}>
          <Md text={o.option} />
          {o.consequence && <Md text={o.consequence} />}
        </Surface>
      ))}
    </div>
  );
}
