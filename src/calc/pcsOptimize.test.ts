import { describe, it, expect } from "vitest";
import { pickSeries, buildCircuits } from "./pcsOptimize";

describe("pickSeries", () => {
  it("割り切れる直列数を選ぶ（24枚は直列12でちょうど2回路）", () => {
    expect(pickSeries(24, 3, 12)).toBe(12);
  });
  it("割り切れないが端数を回路にできる直列数を選ぶ（26枚→直列11で残0）", () => {
    expect(pickSeries(26, 3, 12)).toBe(11);
  });
  it("T が範囲内ならその枚数で1回路（7枚→直列7）", () => {
    expect(pickSeries(7, 3, 12)).toBe(7);
  });
});

describe("buildCircuits", () => {
  it("割り切れる：24枚・範囲[3,12] → 直列12×2回路・残0", () => {
    const r = buildCircuits("pa", 24, { min: 3, max: 12 });
    expect(r.circuits).toEqual([
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ]);
    expect(r.leftover).toBe(0);
  });
  it("端数を短い回路で吸収：26枚・範囲[3,12] → 直列11×2＋直列4×1・残0", () => {
    const r = buildCircuits("pa", 26, { min: 3, max: 12 });
    expect(r.circuits).toEqual([
      { panelId: "pa", series: 11 },
      { panelId: "pa", series: 11 },
      { panelId: "pa", series: 4 },
    ]);
    expect(r.leftover).toBe(0);
  });
  it("下限未満は残：2枚・範囲[3,12] → 回路0・残2", () => {
    const r = buildCircuits("pa", 2, { min: 3, max: 12 });
    expect(r.circuits).toEqual([]);
    expect(r.leftover).toBe(2);
  });
  it("範囲なし（電圧不成立 max<1）は全数残", () => {
    const r = buildCircuits("pa", 10, { min: 5, max: 0 });
    expect(r.circuits).toEqual([]);
    expect(r.leftover).toBe(10);
  });
});

import { distribute } from "./pcsOptimize";
import type { PcsSpec } from "../types";

const PCS_T: PcsSpec = {
  id: "pt", maker: "Test", model: "T", kind: "new",
  ratedPowerKw: 5, mpptCount: 2, multiMppt: true, stringsPerMppt: 2,
  maxInputVoltageV: 600, mpptVoltageMinV: 120, mpptVoltageMaxV: 560,
  maxInputCurrentPerMpptA: 20,
};

describe("distribute", () => {
  it("同一型式5回路を2台へ均等配分（分岐で並列化、合計≤C=3）", () => {
    const circuits = Array.from({ length: 5 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    const counts = r.units.map((u) =>
      (u.strings ?? []).reduce((a, s) => a + s.parallel, 0)
    );
    expect(counts.sort()).toEqual([2, 3]);
    expect(r.leftoverCircuits).toHaveLength(0);
    for (const u of r.units)
      for (const s of u.strings ?? []) expect(s.parallel).toBeLessThanOrEqual(2);
  });

  it("容量不足は余った回路を leftoverCircuits に返す（7回路・2台・C3 → 6配置/1余り）", () => {
    const circuits = Array.from({ length: 7 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    const placed = r.units.flatMap((u) => u.strings ?? []).reduce((a, s) => a + s.parallel, 0);
    expect(placed).toBe(6);
    expect(r.leftoverCircuits).toHaveLength(1);
  });

  it("複数型式は1台のMPPTごとに別型式で同居できる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, PCS_T, 1, 3);
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    const pa = slots.find((s) => s.panelId === "pa");
    const pb = slots.find((s) => s.panelId === "pb");
    expect(pa?.parallel).toBe(2);
    expect(pb?.parallel).toBe(1);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("非マルチMPPT機は1台＝単一型式・単一直列に限定", () => {
    const nonMulti: PcsSpec = { ...PCS_T, multiMppt: false, mpptCount: 1, stringsPerMppt: 4 };
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, nonMulti, 2, 4);
    for (const u of r.units) {
      const ids = new Set((u.strings ?? []).map((s) => s.panelId));
      expect(ids.size).toBeLessThanOrEqual(1);
    }
  });
});

import { optimizePcs } from "./pcsOptimize";
import type { PanelSpec, DesignConditions } from "../types";

const PANEL_A: PanelSpec = {
  id: "pa", maker: "Test", model: "A",
  lengthMm: 1700, widthMm: 1000, pmaxW: 300, vmpV: 40, impA: 9.5, vocV: 50, iscA: 10,
  tempCoeffVocPctPerC: 0, tempCoeffPmaxPctPerC: 0,
};
const PANEL_B: PanelSpec = {
  id: "pb", maker: "Test", model: "B",
  lengthMm: 1700, widthMm: 1000, pmaxW: 360, vmpV: 39, impA: 9.2, vocV: 48, iscA: 9.5,
  tempCoeffVocPctPerC: 0, tempCoeffPmaxPctPerC: 0,
};
const COND: DesignConditions = { minAmbientTempC: -10, maxCellTempC: 70 };

describe("optimizePcs", () => {
  it("単一型式を使い切る（PANEL_A 24枚 / PCS_T 範囲[3,12]→直列12×2回路, 1台に収容）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.leftoverTotal).toBe(0);
    const placed = r.units.flatMap((u) => u.strings ?? [])
      .reduce((a, s) => a + s.series * s.parallel, 0);
    expect(placed).toBe(24);
    expect(r.ampWarnings).toHaveLength(0);
  });

  it("複数型式が1台のMPPTごとに別型式で同居（PANEL_A24 + PANEL_B11）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }, { panelId: "pb", count: 11 }],
      panels: [PANEL_A, PANEL_B], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.units).toHaveLength(1);
    const ids = new Set((r.units[0].strings ?? []).map((s) => s.panelId));
    expect(ids).toEqual(new Set(["pa", "pb"]));
    expect(r.leftoverTotal).toBe(0);
  });

  it("台数不足は残＋必要台数を返す（PANEL_A 84枚=7回路 / 2台・C3 → 6回路配置・1回路残）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 84 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 2, maxCircuitsPerUnit: 3,
    });
    expect(r.leftoverTotal).toBe(12);
    expect(r.unitsNeededForAll).toBe(3);
  });

  it("電流超過は容認して警報に出す（maxInputCurrent16・並列2で 2*10=20>16）", () => {
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_AMP, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3,
    });
    expect(r.ampWarnings.length).toBeGreaterThan(0);
    expect(r.leftoverTotal).toBe(0);
  });
});
