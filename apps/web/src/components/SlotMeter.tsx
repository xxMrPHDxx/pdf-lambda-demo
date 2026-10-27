export function SlotMeter({
  running,
  limit,
  label,
}: {
  running: number;
  limit: number;
  label: string;
}) {
  const ticks = Array.from({ length: limit });
  return (
    <div className="slot-meter" aria-label={`${label}: ${running} of ${limit} slots in use`}>
      <div className="slot-ticks">
        {ticks.map((_, index) => (
          <span
            key={index}
            className={`slot-tick ${index < running ? "filled" : ""}`}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="slot-caption">
        <strong>{running}</strong>
        <span>/ {limit}</span>
      </div>
    </div>
  );
}
