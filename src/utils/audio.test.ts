import { describe, expect, it } from "vitest";
import {
  encodePcm16Wav,
  formatDuration,
  mergeFloat32Chunks,
  resampleLinearPcm,
} from "./audio";

describe("audio helpers", () => {
  it("merges multiple float chunks", () => {
    const merged = mergeFloat32Chunks([
      new Float32Array([0, 0.25]),
      new Float32Array([0.5]),
    ]);
    expect(Array.from(merged)).toEqual([0, 0.25, 0.5]);
  });

  it("resamples to a lower sample rate", () => {
    const input = new Float32Array(44_100).fill(0.5);
    const output = resampleLinearPcm(input, 44_100, 16_000);
    expect(output.length).toBeGreaterThan(15_900);
    expect(output.length).toBeLessThan(16_100);
  });

  it("encodes PCM16 wav with RIFF header", () => {
    const wav = encodePcm16Wav(new Float32Array([0, 0.5, -0.5]), 16_000);
    const magic = String.fromCharCode(...wav.slice(0, 4));
    expect(magic).toBe("RIFF");
    expect(wav.length).toBe(44 + 3 * 2);
  });

  it("formats duration as mm:ss", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(61_000)).toBe("01:01");
  });
});
