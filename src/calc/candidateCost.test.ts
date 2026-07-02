import { describe, it, expect } from "vitest";
import { deriveCostInputs, buildCostInput, computeCandidateCost, computeActiveCost } from "./candidateCost";
import type { PanelArray, PanelSpec, PcsSpec, PowerPlant, CostRates } from "../types";

// ---- テスト用の最小フィクスチャ（計算に使うフィールドだけ実値、他は未使用） ----
const panels = [
  { id: "p360", maker: "ジンコ", model: "JK360", pmaxW: 360, unitPriceYen: 10000 },
  { id: "p700", maker: "トリナ", model: "TR700", pmaxW: 700, unitPriceYen: 25000 },
] as unknown as PanelSpec[];

const pcsList = [
  { id: "huawei", maker: "Huawei", model: "SUN2000", ratedPowerKw: 4.95, mpptCount: 4, unitPriceYen: 75500 },
  { id: "omron", maker: "OMRON", model: "KPV-A55", ratedPowerKw: 5.5, mpptCount: 1 }, // 単価未登録
] as unknown as PcsSpec[];

const rates: CostRates = {
  panelRemovalYen: 3000,
  panelDisposalYen: 2000,
  panelInstallYen: 8000,
  pcsRemovalYen: 15000,
  pcsInstallYen: 30000,
  miscRatePct: 10,
};

function arr(id: string, panelId: string, rows: number, cols: number, over: Partial<PanelArray> = {}): PanelArray {
  return {
    id, panelId, rows, cols,
    orientation: "landscape", gapM: 0.02, posXpx: 0, posYpx: 0, rotationDeg: 0, color: "green",
    ...over,
  };
}

describe("deriveCostInputs（図面からの自動導出）", () => {
  it("既設配列: 流用以外を撤去に計上し、流用kW・現況kWを集計する", () => {
    // 2×3=6枚の既設、流用2枚 → 撤去4枚
    const a = arr("ex", "p360", 2, 3, { keepCells: ["0,0", "0,1"] });
    const d = deriveCostInputs([a], [], undefined, [], panels, pcsList);
    expect(d.removedExisting).toBe(4);
    expect(d.beforeKw).toBeCloseTo((6 * 360) / 1000);
    expect(d.keptKw).toBeCloseTo((2 * 360) / 1000);
    expect(d.newTotal).toBe(0); // 流用ありの既設は新設に計上しない（新設は別配列で置く）
  });

  it("全部入換（流用0）の既設は全数撤去＋同グリッドへ新設を計上する", () => {
    const a = arr("ex", "p360", 2, 3, { keepCells: [] });
    const d = deriveCostInputs([a], [], undefined, [], panels, pcsList);
    expect(d.removedExisting).toBe(6);
    expect(d.newTotal).toBe(6);
    expect(d.newLines).toEqual([{ panelId: "p360", label: "ジンコ JK360", w: 360, count: 6, unitYen: 10000 }]);
  });

  it("新設配列＋単独パネルを型式ごとに合算し、マスタ単価を引く", () => {
    const a = arr("new", "p700", 1, 2); // keepCells 未定義＝新設
    const d = deriveCostInputs([a], [{ id: "f1", panelId: "p700" } as never], undefined, [], panels, pcsList);
    expect(d.newLines).toEqual([{ panelId: "p700", label: "トリナ TR700", w: 700, count: 3, unitYen: 25000 }]);
  });

  it("図面なしのときは手入力の現状（manualCurrent）を撤去対象にする", () => {
    const d = deriveCostInputs([], [], [{ id: "m1", panelId: "p360", count: 10 }], [], panels, pcsList);
    expect(d.removedExisting).toBe(10);
    expect(d.beforeKw).toBeCloseTo(3.6);
  });

  it("新設パワコン台数は台ごとの kind=new だけ数える（count 考慮）", () => {
    const units = [
      { id: "u1", pcsId: "huawei", count: 2, kind: "new" },
      { id: "u2", pcsId: "omron", count: 1, kind: "existing" },
    ] as never;
    const d = deriveCostInputs([], [], undefined, units, panels, pcsList);
    expect(d.newPcs).toBe(2);
  });
});

describe("buildCostInput（手入力→自動導出→既定のフォールバック連鎖）", () => {
  const d = {
    newLines: [{ panelId: "p360", label: "ジンコ JK360", w: 360, count: 6, unitYen: 10000 }],
    newTotal: 6,
    removedExisting: 6,
    keptKw: 0,
    beforeKw: 2.16,
    newPcs: 2,
  };

  it("手入力が無ければ自動導出値（撤去は全数処分・パワコンはマスタ単価）", () => {
    const input = buildCostInput(d, {}, rates, pcsList);
    expect(input.newPanelLines).toHaveLength(1);
    expect(input.removedDisposal).toBe(6);
    expect(input.removedStock).toBe(0);
    expect(input.newPcsCount).toBe(2); // newPcs>0 → pcsMode="new"
    expect(input.pcsUnitYen).toBe(75500); // pcsId 未指定 → pcsList[0] のマスタ単価
    expect(input.extraLines).toEqual([]); // logger 既定 none
  });

  it("手入力があれば自動導出より優先される", () => {
    const input = buildCostInput(
      d,
      {
        panelLines: [{ label: "上書き", w: 700, count: 3, unitYen: 30000 }],
        removedDisposal: 2,
        removedStock: 4,
        pcsMode: "new",
        pcsId: "omron",
        newPcsCount: 1,
        pcsUnitYen: 99000,
        loggerType: "lite",
        loggerUnitYen: 120000,
      },
      rates,
      pcsList
    );
    expect(input.newPanelLines[0]).toMatchObject({ label: "上書き", count: 3, unitYen: 30000 });
    expect(input.removedDisposal).toBe(2);
    expect(input.removedStock).toBe(4);
    expect(input.newPcsCount).toBe(1);
    expect(input.pcsUnitYen).toBe(99000);
    expect(input.extraLines).toEqual([{ label: "監視装置 SmartLogger 3000A Lite版", count: 1, unitYen: 120000 }]);
  });

  it("pcsMode=keep なら新設パワコンは0台", () => {
    const input = buildCostInput(d, { pcsMode: "keep" }, rates, pcsList);
    expect(input.newPcsCount).toBe(0);
  });

  it("単価未登録のパワコン（OMRON）は0円にフォールバックする", () => {
    const input = buildCostInput(d, { pcsMode: "new", pcsId: "omron" }, rates, pcsList);
    expect(input.pcsUnitYen).toBe(0);
  });
});

describe("computeCandidateCost / computeActiveCost", () => {
  // 既設6枚(p360)を全部入換する候補。作業コピー＝合成結果が同じなら両者は一致するはず
  const existingMaster = [arr("ex", "p360", 2, 3)];
  const marks = { ex: { keepCells: [] as string[] } };
  const plant = {
    id: "pl1",
    name: "テスト発電所",
    annualGenerationKwh: 12000,
    fitPriceYenPerKwh: 36,
    fitRemainingYears: 8,
    currentCandidateId: "c1",
    candidates: [{ id: "c1", name: "候補1", arrays: [], existingMarks: marks, cost: {} }],
    activeCost: {},
    pcsUnits: [],
    layout: {
      existingArrays: existingMaster,
      // 作業コピー＝候補c1の合成結果（全部入換）
      arrays: [arr("ex", "p360", 2, 3, { keepCells: [] })],
      freePanels: [],
    },
  } as unknown as PowerPlant;
  const ctx = { panels, pcsList, rates };

  it("保存形式の候補と作業コピーで同じ結果になる（スモーク）", () => {
    const fromCandidate = computeCandidateCost(plant, plant.candidates![0], ctx);
    const fromActive = computeActiveCost(plant, ctx);
    expect(fromCandidate.newPanelCount).toBe(6);
    expect(fromCandidate.removedCount).toBe(6);
    expect(fromCandidate.totalYen).toBe(fromActive.totalYen);
    expect(fromCandidate.paybackYears).toBe(fromActive.paybackYears);
  });

  it("afterGenOverride（変更後発電量の手入力）がROIに反映される", () => {
    const withOverride = {
      ...plant,
      candidates: [{ ...plant.candidates![0], cost: { afterGenOverride: 24000 } }],
    } as PowerPlant;
    const base = computeCandidateCost(plant, plant.candidates![0], ctx);
    const over = computeCandidateCost(withOverride, withOverride.candidates![0], ctx);
    expect(over.annualRevenueIncreaseYen).toBeGreaterThan(base.annualRevenueIncreaseYen);
  });
});
