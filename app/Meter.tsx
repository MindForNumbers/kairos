/** The Director's pressure meter (0-100). Server component, no client JS. */
export default function Meter({ value }: { value: number }) {
  const level = value >= 65 ? "high" : value >= 45 ? "mid" : value >= 20 ? "low" : "calm";
  return (
    <div className={`meter meter-${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={`Pressure ${value} of 100`}>
      <div className="meter-fill" style={{ width: `${value}%` }} />
      <span className="meter-label">{value}</span>
    </div>
  );
}
