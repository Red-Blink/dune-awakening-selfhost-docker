// A small fixed-option picker rendered as a pill radiogroup, matching the
// markup RankSegments uses in features/permissions/rosterEditor.tsx.
//
// RankSegments is deliberately left alone: it is load-bearing for base and
// vehicle permissions, and folding it onto this component is a follow-up worth
// doing on its own rather than inside an unrelated feature.

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  // Spoken name, when the visible label is an abbreviation or needs the row's
  // subject for context ("Read for players" rather than a bare "Read").
  ariaLabel?: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  name,
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  groupClassName = "segmented-control",
  segmentClassName = "segmented-control-segment"
}: {
  // Must be unique per rendered control. Two controls sharing a name would be
  // one browser radio group, so choosing in one silently clears the other.
  name: string;
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  groupClassName?: string;
  segmentClassName?: string;
}) {
  return (
    <div className={groupClassName} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <label className={segmentClassName} key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            aria-label={option.ariaLabel || option.label}
            onChange={() => onChange(option.value)}
          />
          <span aria-hidden="true">{option.label}</span>
        </label>
      ))}
    </div>
  );
}
