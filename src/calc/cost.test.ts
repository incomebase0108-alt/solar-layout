import { describe, it, expect } from "vitest";
import { estimateCost, estimateRoi, estimateAfterGeneration, DEFAULT_SPECIFIC_YIELD_KWH_PER_KW } from "./cost";
import type { CostRates } from "../types";

const rates: CostRates = {
  panelRemovalYen: 3000,
  panelDisposalYen: 2000,
  panelInstallYen: 8000,
  pcsRemovalYen: 15000,
  pcsInstallYen: 30000,
  miscRatePct: 10,
};

describe("概算コスト", () => {
  it("材料費＋設置＋撤去工事＋処分費を積み上げ、諸経費を加算する", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 100,
      removedStock: 0,
      newPcsCount: 0,
      pcsUnitYen: 0,
      removedPcsCount: 0,
      rates,
    });
    // 材料 100*20000=2,000,000 + 設置 100*8000=800,000 + 撤去 100*3000=300,000 + 処分 100*2000=200,000
    expect(r.subtotalYen).toBe(3_300_000);
    expect(r.miscYen).toBe(330_000);
    expect(r.totalYen).toBe(3_630_000);
  });

  it("在庫分は処分費がかからない（撤去工事のみ）", () => {
    const r = estimateCost({
      newPanelLines: [],
      removedDisposal: 30,
      removedStock: 70,
      newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      rates,
    });
    // 撤去工事 (30+70)*3000=300,000 + 処分 30*2000=60,000
    expect(r.subtotalYen).toBe(360_000);
  });

  it("新パネルを複数型式で積み上げる", () => {
    const r = estimateCost({
      newPanelLines: [
        { label: "700W", count: 20, unitYen: 30000, w: 700 },
        { label: "645W", count: 10, unitYen: 25000, w: 645 },
      ],
      removedDisposal: 0, removedStock: 0,
      newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      rates,
    });
    // 材料 20*30000 + 10*25000 = 850,000 + 設置 30*8000=240,000
    expect(r.subtotalYen).toBe(1_090_000);
    // 円/W は (合計*1.1) / (20*700+10*645)
    expect(r.yenPerW).toBeCloseTo((1_090_000 * 1.1) / (20 * 700 + 10 * 645), 2);
  });

  it("新設パワコンの材料・設置・撤去を含む", () => {
    const r = estimateCost({
      newPanelLines: [],
      removedDisposal: 0, removedStock: 0,
      newPcsCount: 7,
      pcsUnitYen: 200000,
      removedPcsCount: 7,
      rates,
    });
    // 材料 7*200000=1,400,000 + 設置 7*30000=210,000 + 撤去 7*15000=105,000
    expect(r.subtotalYen).toBe(1_715_000);
  });

  it("その他費用 inMisc:true は諸経費対象（諸経費が増える）", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "足場", qty: 1, unit: "式", unitYen: 100000, inMisc: true }],
      rates,
    });
    // base: 材料2,000,000 + 設置800,000 = 2,800,000、+足場100,000 → 小計2,900,000
    expect(r.subtotalYen).toBe(2_900_000);
    expect(r.miscYen).toBe(290_000);   // 2,900,000 * 10%
    expect(r.totalYen).toBe(3_190_000);
  });

  it("その他費用 inMisc:false は諸経費対象外（小計・合計に入るが諸経費は増えない）", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "連系負担金", qty: 1, unit: "式", unitYen: 100000, inMisc: false }],
      rates,
    });
    expect(r.subtotalYen).toBe(2_900_000);
    expect(r.miscYen).toBe(280_000);   // base 2,800,000 * 10% のみ
    expect(r.totalYen).toBe(3_180_000); // 小計2,900,000 + 諸経費280,000
  });

  it("その他費用の値引き（単価マイナス）で小計・合計が減る", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "値引き", qty: 1, unit: "式", unitYen: -300000, inMisc: false }],
      rates,
    });
    expect(r.subtotalYen).toBe(2_500_000); // 2,800,000 - 300,000
    expect(r.miscYen).toBe(280_000);       // base 2,800,000 * 10%
    expect(r.totalYen).toBe(2_780_000);
  });

  it("その他費用が見積内訳（lines）に表示行として並ぶ", () => {
    const r = estimateCost({
      newPanelLines: [], removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "申請費", qty: 2, unit: "件", unitYen: 50000, inMisc: false }],
      rates,
    });
    const row = r.lines.find((l) => l.label === "申請費");
    expect(row).toBeTruthy();
    expect(row?.amountYen).toBe(100_000);
    expect(row?.unit).toBe("件");
  });
});

describe("変更後発電量の推定", () => {
  it("容量比でスケールする", () => {
    // 40kW→45kWで1万kWhが11250kWh
    expect(estimateAfterGeneration(10000, 40, 45)).toBeCloseTo(11250, 1);
  });
  it("前容量0（純新設）は容量比が使えないため標準日射量で概算する", () => {
    // 既設なし＝現況比が取れない。後容量50kW × 標準1000kWh/kW = 50000kWh
    expect(estimateAfterGeneration(0, 0, 50)).toBeCloseTo(50 * DEFAULT_SPECIFIC_YIELD_KWH_PER_KW, 1);
  });
  it("後容量も0なら0", () => {
    expect(estimateAfterGeneration(0, 0, 0)).toBe(0);
  });
  it("標準日射量は引数で上書きできる", () => {
    expect(estimateAfterGeneration(0, 0, 50, 1200)).toBeCloseTo(60000, 1);
  });
});

describe("純新設の費用対効果", () => {
  it("既設ゼロでも発電量を概算しROIがマイナスにならない", () => {
    const afterKw = 50;
    const afterAnnualKwh = estimateAfterGeneration(0, 0, afterKw); // 50kW×1,200=60000kWh
    const r = estimateRoi({
      currentAnnualKwh: 0,
      afterAnnualKwh,
      fitPriceYenPerKwh: 18,
      remainingYears: 10,
      upgradeCostYen: 5_000_000,
    });
    // 増分=60000kWh × 18円 × 10年 = 10,800,000円 ＞ 改修費500万 → 正味プラス
    expect(r.deltaAnnualKwh).toBeCloseTo(60000, 1);
    expect(r.netBenefitYen).toBeGreaterThan(0);
    expect(r.roiPct).not.toBeNull();
    expect(r.roiPct!).toBeGreaterThan(0);
  });
});

describe("費用対効果", () => {
  it("増収・回収年数・ROIを算出する", () => {
    const r = estimateRoi({
      currentAnnualKwh: 40000,
      afterAnnualKwh: 45000,
      fitPriceYenPerKwh: 18,
      remainingYears: 10,
      upgradeCostYen: 3_410_000,
    });
    // 増分5000kWh × 18 = 90,000円/年, 10年で900,000円
    expect(r.deltaAnnualKwh).toBe(5000);
    expect(r.annualRevenueIncreaseYen).toBe(90_000);
    expect(r.totalRevenueIncreaseYen).toBe(900_000);
    expect(r.netBenefitYen).toBe(900_000 - 3_410_000);
    // 回収年数 = 3,410,000 / 90,000 ≈ 37.9年
    expect(r.paybackYears).toBeCloseTo(37.9, 1);
  });

  it("増収が0以下なら回収年数はnull", () => {
    const r = estimateRoi({
      currentAnnualKwh: 40000, afterAnnualKwh: 40000,
      fitPriceYenPerKwh: 18, remainingYears: 10, upgradeCostYen: 1_000_000,
    });
    expect(r.paybackYears).toBeNull();
  });
});
