import { describe, it, expect } from "vitest";
import { generateWiring } from "./wiring";
import type { PanelSpec, PcsSpec } from "../types";

const panel: PanelSpec = {
  id: "p1", maker: "t", model: "T-450",
  lengthMm: 2094, widthMm: 1038, pmaxW: 450,
  vmpV: 34.2, impA: 13.16, vocV: 41.3, iscA: 13.9,
  tempCoeffVocPctPerC: -0.27,
};

const pcs: PcsSpec = {
  id: "c1", maker: "t", model: "C-5.5", kind: "new",
  ratedPowerKw: 5.5, mpptCount: 2, stringsPerMppt: 2,
  maxInputVoltageV: 600, mpptVoltageMinV: 80, mpptVoltageMaxV: 500,
  maxInputCurrentPerMpptA: 18,
};

describe("配線生成", () => {
  it("総枚数を直列数で割りストリング化する", () => {
    // 196枚, 14直列 → 14ストリング
    const r = generateWiring(panel, pcs, 14, 1, 196);
    expect(r.totalStrings).toBe(14);
    expect(r.usedPanels).toBe(196);
    expect(r.leftoverPanels).toBe(0);
  });

  it("MPPTあたり並列数・PCSあたりMPPT数で台数が決まる", () => {
    // 14ストリング, 1並列/MPPT, 2MPPT/台 → 2系統/台 → 7台
    const r = generateWiring(panel, pcs, 14, 1, 196);
    expect(r.pcsCount).toBe(7);
    expect(r.perPcs[0].mppts).toHaveLength(2);
  });

  it("割り切れない半端を警告する", () => {
    const r = generateWiring(panel, pcs, 14, 1, 200);
    expect(r.leftoverPanels).toBe(4);
    expect(r.warnings.join()).toMatch(/未接続|半端/);
  });

  it("並列数がMPPT上限を超えると警告", () => {
    const r = generateWiring(panel, pcs, 14, 5, 196);
    expect(r.warnings.join()).toMatch(/最大/);
  });

  it("ストリングを各パワコンへ均等配分する", () => {
    // 13ストリング, maxPerPcs=2 → 7台。差は最大1系統に収まる
    const r = generateWiring(panel, pcs, 14, 1, 13 * 14);
    const counts = r.perPcs.map((p) => p.totalStrings);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("過積載率の平均・範囲を算出する", () => {
    const r = generateWiring(panel, pcs, 14, 1, 196);
    expect(r.avgOverloadPct).toBeGreaterThan(0);
    expect(r.minOverloadPct).toBeLessThanOrEqual(r.maxOverloadPct);
    expect(r.avgOverloadPct).toBeGreaterThanOrEqual(r.minOverloadPct - 1e-9);
    expect(r.avgOverloadPct).toBeLessThanOrEqual(r.maxOverloadPct + 1e-9);
  });
});

describe("影ゾーン", () => {
  // MPPTあたり最大2並列にして余裕を持たせる
  const pcs2 = { ...pcs, stringsPerMppt: 2 };

  it("影ゾーンのパワコンは過積載率が通常台より低い", () => {
    // 並列2/MPPT, 2MPPT → maxPerPcs=4。影1台を負荷率50%に
    const r = generateWiring(panel, pcs2, 10, 2, 30 * 10, 1, 0.5);
    const shaded = r.perPcs.filter((p) => p.isShaded);
    const normal = r.perPcs.filter((p) => !p.isShaded);
    expect(shaded.length).toBe(1);
    const maxShaded = Math.max(...shaded.map((p) => p.overloadPct));
    const maxNormal = Math.max(...normal.map((p) => p.overloadPct));
    expect(maxShaded).toBeLessThan(maxNormal);
  });

  it("影ゾーン0台なら全台通常", () => {
    const r = generateWiring(panel, pcs2, 10, 2, 30 * 10, 0, 0.7);
    expect(r.perPcs.every((p) => !p.isShaded)).toBe(true);
  });
});
