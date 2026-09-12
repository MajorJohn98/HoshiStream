import { describe, expect, it } from "vitest";
import {
  LINE_FIT_MARGIN,
  fitsLine,
  lineFit,
  lineFitNote,
} from "../src/line-fit.ts";

describe("lineFit", () => {
  it("leaves headroom below the raw line speed", () => {
    expect(LINE_FIT_MARGIN).toBe(0.8);
    expect(lineFit(9)).toEqual({ lineMbps: 9, fitMbps: 7.2 });
    expect(lineFit(25.55).fitMbps).toBe(20.4);
  });

  it("decides fit only when both sides are known", () => {
    expect(fitsLine(4, 9)).toBe(true);
    expect(fitsLine(7.2, 9)).toBe(true);
    expect(fitsLine(12, 9)).toBe(false);
    expect(fitsLine(undefined, 9)).toBeUndefined();
    expect(fitsLine(12, undefined)).toBeUndefined();
    expect(fitsLine(0, 9)).toBeUndefined();
    expect(fitsLine(12, 0)).toBeUndefined();
  });

  it("phrases the note in the viewer's terms", () => {
    expect(lineFitNote(12, 9.4)).toBe("needs 12.0 Mbps, line ~9 Mbps");
  });
});
