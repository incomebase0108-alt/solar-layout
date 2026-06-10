import type { CostRates } from "../types";

export interface CostLine {
  label: string;
  qty: number;
  unit: string;
  unitYen: number;
  amountYen: number;
}

export interface CostResult {
  lines: CostLine[];
  subtotalYen: number;
  miscYen: number;
  totalYen: number;
  /** 新設容量あたり単価（円/W）。新設kWが0なら null */
  yenPerW: number | null;
}

export interface CostInput {
  /** 新設パネル枚数 */
  newPanels: number;
  /** 新パネル単価 (円/枚) */
  panelUnitYen: number;
  /** 撤去パネル枚数 */
  removedPanels: number;
  /** 新設パワコン台数 */
  newPcsCount: number;
  /** 新パワコン単価 (円/台) */
  pcsUnitYen: number;
  /** 撤去パワコン台数 */
  removedPcsCount: number;
  /** 新設パネルの合計出力 (W) — 円/W 算出用 */
  newPanelW: number;
  rates: CostRates;
}

/**
 * 入換工事の概算コストを項目別に積み上げる。
 *   材料費（パネル/パワコン）＋ 工事費（設置/撤去）＋ 諸経費。
 */
export function estimateCost(input: CostInput): CostResult {
  const {
    newPanels,
    panelUnitYen,
    removedPanels,
    newPcsCount,
    pcsUnitYen,
    removedPcsCount,
    newPanelW,
    rates,
  } = input;

  const lines: CostLine[] = [
    {
      label: "新パネル 材料費",
      qty: newPanels,
      unit: "枚",
      unitYen: panelUnitYen,
      amountYen: newPanels * panelUnitYen,
    },
    {
      label: "パネル 設置工事",
      qty: newPanels,
      unit: "枚",
      unitYen: rates.panelInstallYen,
      amountYen: newPanels * rates.panelInstallYen,
    },
    {
      label: "既設パネル 撤去",
      qty: removedPanels,
      unit: "枚",
      unitYen: rates.panelRemovalYen,
      amountYen: removedPanels * rates.panelRemovalYen,
    },
    {
      label: "新パワコン 材料費",
      qty: newPcsCount,
      unit: "台",
      unitYen: pcsUnitYen,
      amountYen: newPcsCount * pcsUnitYen,
    },
    {
      label: "パワコン 設置工事",
      qty: newPcsCount,
      unit: "台",
      unitYen: rates.pcsInstallYen,
      amountYen: newPcsCount * rates.pcsInstallYen,
    },
    {
      label: "既設パワコン 撤去",
      qty: removedPcsCount,
      unit: "台",
      unitYen: rates.pcsRemovalYen,
      amountYen: removedPcsCount * rates.pcsRemovalYen,
    },
  ].filter((l) => l.qty > 0);

  const subtotalYen = lines.reduce((s, l) => s + l.amountYen, 0);
  const miscYen = Math.round((subtotalYen * rates.miscRatePct) / 100);
  const totalYen = subtotalYen + miscYen;
  const yenPerW = newPanelW > 0 ? totalYen / newPanelW : null;

  return { lines, subtotalYen, miscYen, totalYen, yenPerW };
}

// ============================================================
// 費用対効果（ROI）
// ============================================================

/** 容量比で変更後の年間発電量を推定する（現状発電量 × 後容量/前容量）。 */
export function estimateAfterGeneration(
  currentAnnualKwh: number,
  beforeKw: number,
  afterKw: number
): number {
  if (beforeKw <= 0) return 0;
  return (currentAnnualKwh * afterKw) / beforeKw;
}

export interface RoiInput {
  /** 現在の年間発電量 (kWh/年) */
  currentAnnualKwh: number;
  /** 変更後の年間発電量 (kWh/年) */
  afterAnnualKwh: number;
  /** FIT買取単価 (円/kWh) */
  fitPriceYenPerKwh: number;
  /** FIT残存年数 (年) */
  remainingYears: number;
  /** 改修費用 (円) */
  upgradeCostYen: number;
}

export interface RoiResult {
  /** 年間発電量の増分 (kWh/年) */
  deltaAnnualKwh: number;
  /** 年間増収 (円/年) */
  annualRevenueIncreaseYen: number;
  /** 残存期間の累計増収 (円) */
  totalRevenueIncreaseYen: number;
  /** 正味便益 = 累計増収 − 改修費用 (円) */
  netBenefitYen: number;
  /** 投資回収年数 (年)。増収が0以下なら null */
  paybackYears: number | null;
  /** ROI = 正味便益 / 改修費用 (%)。費用0なら null */
  roiPct: number | null;
}

/** 費用対効果を算出する。 */
export function estimateRoi(input: RoiInput): RoiResult {
  const deltaAnnualKwh = input.afterAnnualKwh - input.currentAnnualKwh;
  const annualRevenueIncreaseYen = deltaAnnualKwh * input.fitPriceYenPerKwh;
  const totalRevenueIncreaseYen = annualRevenueIncreaseYen * input.remainingYears;
  const netBenefitYen = totalRevenueIncreaseYen - input.upgradeCostYen;
  const paybackYears =
    annualRevenueIncreaseYen > 0
      ? input.upgradeCostYen / annualRevenueIncreaseYen
      : null;
  const roiPct =
    input.upgradeCostYen > 0
      ? (netBenefitYen / input.upgradeCostYen) * 100
      : null;
  return {
    deltaAnnualKwh,
    annualRevenueIncreaseYen,
    totalRevenueIncreaseYen,
    netBenefitYen,
    paybackYears,
    roiPct,
  };
}
