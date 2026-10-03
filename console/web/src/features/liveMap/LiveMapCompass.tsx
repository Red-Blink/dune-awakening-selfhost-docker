const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** The compass bearing the view faces (screen-up), degrees clockwise from north, 0..360. */
export function viewBearing(yaw: number): number {
  const deg = ((yaw * 180) / Math.PI) % 360;
  return deg < 0 ? deg + 360 : deg;
}

/** The nearest of the eight points for a bearing. */
export function bearingName(bearing: number): string {
  return POINTS[Math.round(bearing / 45) % 8];
}

const R = 20;

/**
 * Shown while the map is turned or tilted: where north lies on screen. North is
 * the map's top edge (sector row I); clicking turns the view back to face it.
 */
export function LiveMapCompass({ yaw, onFaceNorth }: { yaw: number; onFaceNorth: () => void }) {
  const bearing = viewBearing(yaw);
  const label = `Facing ${bearingName(bearing)} (${Math.round(bearing) % 360}°). Click to face north.`;
  const at = (deg: number) => {
    const a = ((deg - bearing) * Math.PI) / 180;
    return { x: R * Math.sin(a), y: -R * Math.cos(a) };
  };
  return (
    <button type="button" className="live-map-compass" aria-label={label} title={label} onClick={onFaceNorth}>
      <svg viewBox="-32 -32 64 64" aria-hidden="true">
        <circle className="dial" r={30} />
        <g transform={`rotate(${-bearing})`}>
          <polygon className="needle-north" points="0,-15 5,0 -5,0" />
          <polygon className="needle-south" points="0,15 5,0 -5,0" />
        </g>
        {["N", "E", "S", "W"].map((name, i) => {
          const p = at(i * 90);
          return <text key={name} className={name === "N" ? "north" : undefined} x={p.x} y={p.y}>{name}</text>;
        })}
      </svg>
    </button>
  );
}
