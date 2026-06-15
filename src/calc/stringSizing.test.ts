import { describe, it, expect } from "vitest";
import { calcStringSizing, calcArrayCapacity, vocAtTemp, vmpAtTemp } from "./stringSizing";
import type { PanelSpec, PcsSpec } from "../types";

const panel: PanelSpec = {
  id: "p1",
  maker: "テスト",
  model: "T-450",
  lengthMm: 2094,
  widthMm: 1038,
  pmaxW: 450,
  vmpV: 34.2,
  impA: 13.16,
  vocV: 41.3,
  iscA: 13.9,
  tempCoeffVocPctPerC: -0.27,
  tempCoeffPmaxPctPerC: -0.34,
};

const pcs: PcsSpec = {
  id: "c1",
  maker: "テスト",
  model: "C-5.5",
  kind: "new",
  ratedPowerKw: 5.5,
  mpptCount: 2,
  stringsPerMppt: 2,
  maxInputVoltageV: 600,
  mpptVoltageMinV: 80,
  mpptVoltageMaxV: 500,
  startVoltageV: 100,
  maxInputCurrentPerMpptA: 18,
};

describe("温度補正", () => {
  it("低温で Voc が上昇する", () => {
    const v = vocAtTemp(panel, -10);
    expect(v).toBeGreaterThan(panel.vocV);
    // 41.3 * (1 + (-0.27/100)*(-35)) = 41.3 * 1.0945 ≈ 45.2
    expect(v).toBeCloseTo(45.2, 1);
  });
  it("高温で Vmp が低下する", () => {
    const v = vmpAtTemp(panel, 70);
    expect(v).toBeLessThan(panel.vmpV);
  });
});

describe("ストリング計算", () => {
  const r = calcStringSizing(panel, pcs, { minAmbientTempC: -10, maxCellTempC: 70 });

  it("最大直列数は低温Vocと最大入力電圧から決まる", () => {
    // floor(600 / 45.2) = 13
    expect(r.seriesMaxByVoltage).toBe(13);
  });
  it("最小直列数は1以上", () => {
    expect(r.seriesRange.min).toBeGreaterThanOrEqual(1);
  });
  it("並列数は電流制約で決まる", () => {
    // floor(18 / 13.9) = 1, ハード上限2 → min=1
    expect(r.parallelMaxPerMppt).toBe(1);
  });
  it("成立する組合せでは警告が直列不成立を含まない", () => {
    expect(r.seriesRange.min).toBeLessThanOrEqual(r.seriesRange.max);
  });
});

describe("容量計算", () => {
  it("過積載率を算出する", () => {
    const cap = calcArrayCapacity(panel, pcs, 13, 1);
    // 13 * 1 * 2 = 26枚, 26*450=11700W=11.7kW, /5.5=212%
    expect(cap.maxPanelsPerPcs).toBe(26);
    expect(cap.maxDcKw).toBeCloseTo(11.7, 1);
    expect(cap.overloadPct).toBeCloseTo(212.7, 0);
  });
});
