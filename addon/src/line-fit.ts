// Whether a file's average bitrate fits the measured (or configured) line.
// One rule, used by the stream list and the management UI so they never
// disagree: a file fits when it needs at most 80 % of the line, leaving
// headroom for swarm variance and other traffic.
export const LINE_FIT_MARGIN = 0.8;

export interface LineFit {
  lineMbps: number;
  /** Highest average bitrate that fits this line. */
  fitMbps: number;
}

export function lineFit(lineMbps: number): LineFit {
  return {
    lineMbps,
    fitMbps: Number((lineMbps * LINE_FIT_MARGIN).toFixed(1)),
  };
}

/**
 * True when the file fits, false when it does not, undefined when either
 * side is unknown (no probe yet, or no usable line speed).
 */
export function fitsLine(
  bitrateMbps: number | undefined,
  lineMbps: number | undefined,
): boolean | undefined {
  if (!bitrateMbps || !lineMbps || bitrateMbps <= 0 || lineMbps <= 0)
    return undefined;
  return bitrateMbps <= lineMbps * LINE_FIT_MARGIN;
}

export function lineFitNote(bitrateMbps: number, lineMbps: number): string {
  return `needs ${bitrateMbps.toFixed(1)} Mbps, line ~${Math.round(lineMbps)} Mbps`;
}
