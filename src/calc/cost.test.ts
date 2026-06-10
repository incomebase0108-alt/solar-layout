import { describe, it, expect } from "vitest";
import { estimateCost, estimateRoi, estimateAfterGeneration } from "./cost";
import type { CostRates } from "../types";

const rates: CostRates = {
  panelRemovalYen: 3000,
  panelInstallYen: 8000,
  pcsRemovalYen: 15000,
  pcsInstallYen: 30000,
  miscRatePct: 10,
};

describe("概算コスト", () => {
  it("材料費＋工事費＋撤去費を積み上げ、諸経費を加算する", () => {
    const r = estimateCost({
      newPanels: 100,
      panelUnitYen: 20000,
      removedPanels: 100,
      newPcsCount: 0,
      pcsUnitYen: 0,
      removedPcsCount: 0,
      newPanelW: 45000,
      rates,
    });
    // 材料 100*20000=2,000,000 + 設置 100*8000=800,000 + 撤去 100*3000=300,000
    expect(r.subtotalYen).toBe(3_100_000);
    expect(r.miscYen).toBe(310_000);
    expect(r.totalYen).toBe(3_410_000);
  });

  it("新設パワコンの材料・設置・撤去を含む", () => {
    const r = estimateCost({
      newPanels: 0,
      panelUnitYen: 0,
      removedPanels: 0,
      newPcsCount: 7,
      pcsUnitYen: 200000,
      removedPcsCount: 7,
      newPanelW: 0,
      rates,
    });
    // 材料 7*200000=1,400,000 + 設置 7*30000=210,000 + 撤去 7*15000=105,000
    expect(r.subtotalYen).toBe(1_715_000);
  });

  it("数量0の項目は明細から除外される", () => {
    const r = estimateCost({
      newPanels: 10, panelUnitYen: 20000, removedPanels: 0,
      newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      newPanelW: 4500, rates,
    });
    // 新パネル材料 + 設置 の2項目のみ（撤去・パワコン系は0で除外）
    expect(r.lines).toHaveLength(2);
  });

  it("円/Wを算出する", () => {
    const r = estimateCost({
      newPanels: 100, panelUnitYen: 20000, removedPanels: 100,
      newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      newPanelW: 45000, rates,
    });
    expect(r.yenPerW).toBeCloseTo(3_410_000 / 45000, 2);
  });
});

describe("変更後発電量の推定", () => {
  it("容量比でスケールする", () => {
    // 40kW→45kWで1万kWhが11250kWh
    expect(estimateAfterGeneration(10000, 40, 45)).toBeCloseTo(11250, 1);
  });
  it("前容量0なら0", () => {
    expect(estimateAfterGeneration(10000, 0, 45)).toBe(0);
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
