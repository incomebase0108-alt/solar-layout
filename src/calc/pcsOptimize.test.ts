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
  it("既定(spread)：同一型式5回路を2台へ均等配分（合計≤C=3・並列≤2）", () => {
    const circuits = Array.from({ length: 5 }, () => ({ panelId: "pa", series: 12 }));
    const r = distribute(circuits, PCS_T, 2, 3);
    const counts = r.units.map((u) => (u.strings ?? []).reduce((a, s) => a + s.parallel, 0));
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

  it("spread：同一型式2回路は別MPPTに散らし分岐しない（並列はすべて1）", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ];
    const r = distribute(circuits, PCS_T, 1, 4, "spread");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(2); // 別MPPTに2行
    for (const s of slots) expect(s.parallel).toBe(1);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("dense：同一型式2回路は分岐2並列で1MPPTに束ねる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ];
    const r = distribute(circuits, PCS_T, 1, 4, "dense");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(1); // 1MPPTに束ねる
    expect(slots[0].parallel).toBe(2);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("dense：複数型式は分岐で空きMPPTを作り1台に同居できる", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
      { panelId: "pb", series: 11 },
    ];
    const r = distribute(circuits, PCS_T, 1, 3, "dense");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    const pa = slots.find((s) => s.panelId === "pa");
    const pb = slots.find((s) => s.panelId === "pb");
    expect(pa?.parallel).toBe(2);
    expect(pb?.parallel).toBe(1);
    expect(r.leftoverCircuits).toHaveLength(0);
  });

  it("spread：空きMPPTが尽きたら分岐にフォールバックする（同型3回路・1台・MPPT2）", () => {
    const circuits = [
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
      { panelId: "pa", series: 12 },
    ];
    const r = distribute(circuits, PCS_T, 1, 4, "spread");
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(2); // まず別MPPTに2行、3本目は分岐
    const maxParallel = Math.max(...slots.map((s) => s.parallel));
    expect(maxParallel).toBe(2); // 3本目が分岐2並列に
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
  it("単一型式を使い切る（PANEL_A 24枚 / 既定spread → 1台に24枚・残0）", () => {
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

  it("spread：同一型式は分岐せず別MPPT（並列はすべて1・電流警報なし）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "spread",
    });
    expect(r.units).toHaveLength(1);
    const slots = r.units[0].strings ?? [];
    expect(slots).toHaveLength(2);
    for (const s of slots) expect(s.parallel).toBe(1);
    expect(r.ampWarnings).toHaveLength(0);
    expect(r.leftoverTotal).toBe(0);
  });

  it("dense：複数型式が1台のMPPTごとに別型式で同居（PANEL_A24 + PANEL_B11）", () => {
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }, { panelId: "pb", count: 11 }],
      panels: [PANEL_A, PANEL_B], pcs: PCS_T, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "dense",
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

  it("dense：電流超過は容認して警報に出す（maxInputCurrent16・分岐並列2で 2*10=20>16）", () => {
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const r = optimizePcs({
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A], pcs: PCS_AMP, conditions: COND,
      unitCount: 1, maxCircuitsPerUnit: 3, strategy: "dense",
    });
    expect(r.ampWarnings.length).toBeGreaterThan(0);
    expect(r.leftoverTotal).toBe(0);
  });
});

import { optimizeIntoUnits, optimizeIntoUnitsPatterns } from "./pcsOptimize";
import type { PcsUnitLine } from "../types";

// PANEL_A(vocV50/vmpV40) × PCS_T → seriesRange {3,12}
// PCS_HI: mpptVoltageMinV を上げて下限を 11 にした機種 → seriesRange {11,12}
const PCS_HI: PcsSpec = { ...PCS_T, id: "phi", model: "HI", mpptVoltageMinV: 440 };
// 同レンジの別機種（混在テスト用）
const PCS_T2: PcsSpec = { ...PCS_T, id: "pt2", model: "T2" };

describe("optimizeIntoUnits", () => {
  it("混在2機種・各1台：各台が自機種の strings を受領し、id/pcsId/kind/note を保持", () => {
    const units: PcsUnitLine[] = [
      { id: "u1", pcsId: "pt", count: 1, kind: "new", note: "南面", strings: [] },
      { id: "u2", pcsId: "pt2", count: 1, kind: "existing", note: "北面", strings: [] },
    ];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 48 }],
      panels: [PANEL_A],
      pcsList: [PCS_T, PCS_T2],
      conditions: COND,
      maxCircuitsPerUnit: 2, // 各台2回路に制限して機種ごとに分け合うことを確認
    });
    expect(r.empty).toBe(false);
    expect(r.units).toHaveLength(2);
    // 同一性の保持
    expect(r.units[0]).toMatchObject({ id: "u1", pcsId: "pt", kind: "new", note: "南面" });
    expect(r.units[1]).toMatchObject({ id: "u2", pcsId: "pt2", kind: "existing", note: "北面" });
    // 各台が strings を受領
    const cells = (u: PcsUnitLine) => (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0);
    expect(cells(r.units[0])).toBe(24);
    expect(cells(r.units[1])).toBe(24);
    expect(r.leftoverTotal).toBe(0);
  });

  it("繰越：機種Aの電圧範囲外のパネルを機種Bが回路化する", () => {
    // pa:10枚。PCS_HI は下限11本で 10枚は回路不可 → PCS_T(下限3本)が拾う
    const units: PcsUnitLine[] = [
      { id: "a", pcsId: "phi", count: 1, strings: [] },
      { id: "b", pcsId: "pt", count: 1, strings: [] },
    ];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 10 }],
      panels: [PANEL_A],
      pcsList: [PCS_HI, PCS_T],
      conditions: COND,
    });
    expect(r.units[0].strings ?? []).toHaveLength(0); // 機種A=割当なし
    const cellsB = (r.units[1].strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0);
    expect(cellsB).toBe(10); // 機種Bが10枚を回路化
    expect(r.leftoverTotal).toBe(0);
  });

  it("余り：入りきらない分は leftover＋機種別の追加台数目安を返す（台数は増やさない）", () => {
    const units: PcsUnitLine[] = [{ id: "u1", pcsId: "pt", count: 1, strings: [] }];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 100 }],
      panels: [PANEL_A],
      pcsList: [PCS_T],
      conditions: COND,
    });
    // 1台=2MPPT×直列12=24枚が上限。100枚中24枚配置・残76枚。
    expect(r.leftoverTotal).toBe(76);
    expect(r.units).toHaveLength(1); // 台数は増えない
    expect(r.extraUnitsNeeded).toHaveLength(1);
    // 残76枚 ÷ (2MPPT×最大12直=24枚/台) = 約4台
    expect(r.extraUnitsNeeded[0]).toMatchObject({ pcsId: "pt", count: 4 });
  });

  it("strings のみ差替・台数同順を保持し、全台へ均等に配る", () => {
    const units: PcsUnitLine[] = [
      { id: "u1", pcsId: "pt", count: 1, strings: [] },
      { id: "u2", pcsId: "pt", count: 1, strings: [] },
      { id: "u3", pcsId: "pt", count: 1, strings: [] },
    ];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A],
      pcsList: [PCS_T],
      conditions: COND,
    });
    expect(r.units.map((u) => u.id)).toEqual(["u1", "u2", "u3"]);
    // 24枚を3台×2MPPT=6本へ均等＝各本4直 → 各台8枚（均一）
    const cells = r.units.map((u) => (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0));
    expect(cells).toEqual([8, 8, 8]);
    expect(r.leftoverTotal).toBe(0);
  });

  it("2型式×マルチMPPTなし機：型式ごとに台数を配分し、両型式とも割り当てる（片方だけ使い切らない）", () => {
    // OMRON KPV相当（1MPPT・並列4・マルチなし＝1台1型式）。電流40A・パネルIsc≈10で並列4まで有効。
    const PCS_NM: PcsSpec = {
      id: "pnm", maker: "Test", model: "NM", kind: "new",
      ratedPowerKw: 5, mpptCount: 1, multiMppt: false, stringsPerMppt: 4,
      maxInputVoltageV: 600, mpptVoltageMinV: 90, mpptVoltageMaxV: 560,
      maxInputCurrentPerMpptA: 40,
    };
    const units: PcsUnitLine[] = Array.from({ length: 4 }, (_, i) => ({
      id: `u${i + 1}`, pcsId: "pnm", count: 1, strings: [],
    }));
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 96 }, { panelId: "pb", count: 48 }],
      panels: [PANEL_A, PANEL_B],
      pcsList: [PCS_NM],
      conditions: COND,
    });
    // 両型式とも余らず割り当てられる（SANKOだけ使い切ってTrina余り、を防ぐ）
    expect(r.leftoverTotal).toBe(0);
    const used = (id: string) =>
      r.units.flatMap((u) => u.strings ?? []).filter((s) => s.panelId === id).reduce((a, s) => a + s.series * s.parallel, 0);
    expect(used("pa")).toBe(96);
    expect(used("pb")).toBe(48);
    // マルチMPPTなし機：各台は単一型式（混在しない）
    for (const u of r.units) {
      const ids = new Set((u.strings ?? []).map((s) => s.panelId));
      expect(ids.size).toBeLessThanOrEqual(1);
    }
  });

  it("非マルチ機：単一型式なら全台へ均一に配り、過積載率をそろえる", () => {
    const PCS_NM: PcsSpec = {
      id: "pnm", maker: "Test", model: "NM", kind: "new",
      ratedPowerKw: 5, mpptCount: 1, multiMppt: false, stringsPerMppt: 4,
      maxInputVoltageV: 600, mpptVoltageMinV: 90, mpptVoltageMaxV: 560,
      maxInputCurrentPerMpptA: 40,
    };
    // 6台・pa96枚 → 6台×並列4=24本へ均等＝各本4直 → 各台16枚（全台同一＝過積載率も同一）
    const units: PcsUnitLine[] = Array.from({ length: 6 }, (_, i) => ({
      id: `u${i + 1}`, pcsId: "pnm", count: 1, strings: [],
    }));
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 96 }],
      panels: [PANEL_A],
      pcsList: [PCS_NM],
      conditions: COND,
    });
    const counts = r.units.map((u) => (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0));
    expect(counts).toEqual([16, 16, 16, 16, 16, 16]); // 全台均一
    // 各台：単一型式・同一直列
    for (const u of r.units) {
      expect(new Set((u.strings ?? []).map((s) => s.panelId)).size).toBe(1);
      expect(new Set((u.strings ?? []).map((s) => s.series)).size).toBe(1);
    }
    expect(r.leftoverTotal).toBe(0);
  });

  it("過積載率を全台でそろえる（W違いの型式を直列数で吸収）", () => {
    const PCS_NM: PcsSpec = {
      id: "pnm", maker: "Test", model: "NM", kind: "new",
      ratedPowerKw: 5, mpptCount: 1, multiMppt: false, stringsPerMppt: 4,
      maxInputVoltageV: 600, mpptVoltageMinV: 90, mpptVoltageMaxV: 560,
      maxInputCurrentPerMpptA: 40,
    };
    const units: PcsUnitLine[] = Array.from({ length: 8 }, (_, i) => ({ id: `u${i + 1}`, pcsId: "pnm", count: 1, strings: [] }));
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 192 }, { panelId: "pb", count: 96 }],
      panels: [PANEL_A, PANEL_B],
      pcsList: [PCS_NM],
      conditions: COND,
    });
    expect(r.leftoverTotal).toBe(0); // 全パネル使用
    const ps = [PANEL_A, PANEL_B];
    const overloads = r.units
      .map((u) => (u.strings ?? []).reduce((a, s) => a + s.series * s.parallel * (ps.find((p) => p.id === s.panelId)?.pmaxW ?? 0), 0) / 5000)
      .filter((o) => o > 0);
    const spread = Math.max(...overloads) - Math.min(...overloads);
    expect(spread).toBeLessThan(0.3); // 過積載率の幅は30ポイント未満（手計算の約36ptより狭い）
    for (const u of r.units) {
      if ((u.strings ?? []).length === 0) continue;
      expect(new Set((u.strings ?? []).map((s) => s.panelId)).size).toBe(1); // 単一型式
      expect(new Set((u.strings ?? []).map((s) => s.series)).size).toBe(1); // 同一直列
    }
  });

  it("端数は既存ストリングの直列+1で吸収し、残ゼロに近づける（マルチ機）", () => {
    const PCS_NM: PcsSpec = {
      id: "pnm", maker: "Test", model: "NM", kind: "new",
      ratedPowerKw: 5, mpptCount: 1, multiMppt: false, stringsPerMppt: 4,
      maxInputVoltageV: 600, mpptVoltageMinV: 90, mpptVoltageMaxV: 560,
      maxInputCurrentPerMpptA: 40,
    };
    // u1=マルチ(2MPPT) + u2=非マルチ(並列4)。pa22 は非マルチ側に端数2が出るが、
    // マルチ機のストリングを直列+1して使い切る。
    const units: PcsUnitLine[] = [
      { id: "u1", pcsId: "pt", count: 1, strings: [] },
      { id: "u2", pcsId: "pnm", count: 1, strings: [] },
    ];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 22 }],
      panels: [PANEL_A],
      pcsList: [PCS_T, PCS_NM],
      conditions: COND,
    });
    expect(r.leftoverTotal).toBe(0);
    const total = r.units.flatMap((u) => u.strings ?? []).reduce((a, s) => a + s.series * s.parallel, 0);
    expect(total).toBe(22);
    // 直列は電圧範囲内（3..12）
    for (const u of r.units) for (const s of u.strings ?? []) {
      expect(s.series).toBeGreaterThanOrEqual(3);
      expect(s.series).toBeLessThanOrEqual(12);
    }
  });

  it("おすすめ3案：組み方（ストリング本数）が変わる（影に強い＞配線シンプル）", () => {
    // KPR相当：4MPPT・1本/MPPT・マルチ。パネルは range{2,9}（vocV50/maxV450）。
    const PCS_KPR: PcsSpec = {
      id: "pkpr", maker: "OMRON", model: "KPR", kind: "new",
      ratedPowerKw: 5.6, mpptCount: 4, multiMppt: true, stringsPerMppt: 1,
      maxInputVoltageV: 450, mpptVoltageMinV: 50, mpptVoltageMaxV: 450,
      maxInputCurrentPerMpptA: 12,
    };
    const units: PcsUnitLine[] = Array.from({ length: 4 }, (_, i) => ({ id: `u${i + 1}`, pcsId: "pkpr", count: 1, strings: [] }));
    const pats = optimizeIntoUnitsPatterns({
      units,
      inventory: [{ panelId: "pa", count: 72 }],
      panels: [PANEL_A],
      pcsList: [PCS_KPR],
      conditions: COND,
    });
    expect(pats).toHaveLength(3);
    const strCount = (key: string) =>
      pats.find((p) => p.key === key)!.result.units.reduce((a, u) => a + (u.strings ?? []).length, 0);
    // 影に強い（短・多）＞ 配線シンプル（長・少）
    expect(strCount("shade")).toBeGreaterThan(strCount("wiring"));
    // どの案も全72枚を使い切る
    for (const p of pats) expect(p.result.leftoverTotal).toBe(0);
  });

  it("非マルチ機：端数は並列内で±1直の混在にして使い切る（違反を作らない）", () => {
    // KPW相当：1MPPT・並列4・マルチなし。26枚を 4並列以内・±1直で割り切る（例 7直2並+6直2並 や 9直2並+8直1並）。
    const PCS_NM: PcsSpec = {
      id: "pnm", maker: "Test", model: "NM", kind: "new",
      ratedPowerKw: 5, mpptCount: 1, multiMppt: false, stringsPerMppt: 4,
      maxInputVoltageV: 600, mpptVoltageMinV: 90, mpptVoltageMaxV: 560,
      maxInputCurrentPerMpptA: 40,
    };
    const r = optimizeIntoUnits({
      units: [{ id: "u1", pcsId: "pnm", count: 1, strings: [] }],
      inventory: [{ panelId: "pa", count: 26 }],
      panels: [PANEL_A],
      pcsList: [PCS_NM],
      conditions: COND,
    });
    expect(r.leftoverTotal).toBe(0); // 端数も使い切る
    const ss = r.units[0].strings ?? [];
    expect(ss.reduce((a, s) => a + s.parallel, 0)).toBeLessThanOrEqual(4); // 並列合計 ≤ 上限4（違反なし）
    const sv = ss.map((s) => s.series);
    expect(Math.max(...sv) - Math.min(...sv)).toBeLessThanOrEqual(1); // 直列の差は±1以内
    expect(ss.reduce((a, s) => a + s.series * s.parallel, 0)).toBe(26); // 合計26枚
  });

  it("一覧が空：empty=true・全在庫が leftover", () => {
    const r = optimizeIntoUnits({
      units: [],
      inventory: [{ panelId: "pa", count: 10 }],
      panels: [PANEL_A],
      pcsList: [PCS_T],
      conditions: COND,
    });
    expect(r.empty).toBe(true);
    expect(r.units).toHaveLength(0);
    expect(r.leftoverTotal).toBe(10);
  });

  it("maxCircuitsPerUnit で1台あたりのストリング本数を制限できる", () => {
    const units: PcsUnitLine[] = [{ id: "u1", pcsId: "pt", count: 1, strings: [] }];
    const base = {
      units,
      inventory: [{ panelId: "pa", count: 48 }],
      panels: [PANEL_A],
      pcsList: [PCS_T],
      conditions: COND,
    };
    const def = optimizeIntoUnits(base); // 既定=MPPT2本×最大12直=24枚 → 残24
    expect(def.leftoverTotal).toBe(24);
    const cap1 = optimizeIntoUnits({ ...base, maxCircuitsPerUnit: 1 }); // 1本×12直=12枚 → 残36
    expect(cap1.leftoverTotal).toBe(36);
  });

  it("電流制約：2並列で電流超過する機種は分岐しない（赤エラーを出さない・全ストリング並列1）", () => {
    // PCS_AMP は MPPT最大16A、PANEL_A は Isc10A → 2並列=20A は不可 → 有効並列1（分岐なし）
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const units: PcsUnitLine[] = [{ id: "u1", pcsId: "pamp", count: 1, strings: [] }];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 24 }],
      panels: [PANEL_A],
      pcsList: [PCS_AMP],
      conditions: COND,
      strategy: "dense",
    });
    for (const s of r.units[0].strings ?? []) expect(s.parallel).toBe(1); // 分岐しない
    expect(r.ampWarnings).toHaveLength(0); // 電流超過を作らない
    expect(r.leftoverTotal).toBe(0); // 2MPPT×1並列=2回路=24枚で収まる
  });

  it("電流制約：MPPTが余っていても電流上限を超える分は残にする（過剰割り当てしない）", () => {
    // PCS_AMP(16A)・PANEL_A(10A)：1台=2MPPT×並列1=2回路まで。48枚=4回路 → 2回路(24枚)配置・残24
    const PCS_AMP: PcsSpec = { ...PCS_T, id: "pamp", maxInputCurrentPerMpptA: 16 };
    const units: PcsUnitLine[] = [{ id: "u1", pcsId: "pamp", count: 1, strings: [] }];
    const r = optimizeIntoUnits({
      units,
      inventory: [{ panelId: "pa", count: 48 }],
      panels: [PANEL_A],
      pcsList: [PCS_AMP],
      conditions: COND,
    });
    expect(r.leftoverTotal).toBe(24);
    expect(r.extraUnitsNeeded[0]).toMatchObject({ pcsId: "pamp", count: 1 });
  });
});
