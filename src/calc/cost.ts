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

/** 新設パネルの1行（型式ごと）。 */
export interface NewPanelLine {
  /** 表示名（メーカー＋型式） */
  label: string;
  /** 枚数 */
  count: number;
  /** 単価 (円/枚) */
  unitYen: number;
  /** 1枚の出力 (W) — 円/W 算出用 */
  w: number;
}

export interface CostInput {
  /** 新設パネル（型式ごとに複数行可） */
  newPanelLines: NewPanelLine[];
  /** 撤去した既設パネルのうち「処分」に回す枚数 */
  removedDisposal: number;
  /** 撤去した既設パネルのうち「在庫」に回す枚数（処分費はかからない） */
  removedStock: number;
  /** 新設パワコン台数 */
  newPcsCount: number;
  /** 新パワコン単価 (円/台) */
  pcsUnitYen: number;
  /** 撤去パワコン台数 */
  removedPcsCount: number;
  /** 周辺機器など追加の材料費行（監視装置など）。任意。 */
  extraLines?: { label: string; count: number; unitYen: number }[];
  rates: CostRates;
}

/**
 * 入換工事の概算コストを項目別に積み上げる。
 *   材料費（新パネル各型式/パワコン）＋ 工事費（設置/撤去）＋ 処分費 ＋ 諸経費。
 *   撤去は「処分」「在庫」に分け、処分費は処分分だけ。撤去工事費は両方にかかる。
 */
export function estimateCost(input: CostInput): CostResult {
  const { newPanelLines, removedDisposal, removedStock, newPcsCount, pcsUnitYen, removedPcsCount, rates } = input;

  const newPanelsTotal = newPanelLines.reduce((s, l) => s + l.count, 0);
  const newPanelW = newPanelLines.reduce((s, l) => s + l.count * l.w, 0);
  const removedTotal = removedDisposal + removedStock;

  const lines: CostLine[] = [
    // 新パネル材料費（型式ごと）
    ...newPanelLines.map((l) => ({
      label: `新パネル 材料費（${l.label}）`,
      qty: l.count,
      unit: "枚",
      unitYen: l.unitYen,
      amountYen: l.count * l.unitYen,
    })),
    {
      label: "パネル 設置工事",
      qty: newPanelsTotal,
      unit: "枚",
      unitYen: rates.panelInstallYen,
      amountYen: newPanelsTotal * rates.panelInstallYen,
    },
    {
      label: "既設パネル 撤去工事（処分＋在庫）",
      qty: removedTotal,
      unit: "枚",
      unitYen: rates.panelRemovalYen,
      amountYen: removedTotal * rates.panelRemovalYen,
    },
    {
      label: "既設パネル 処分費",
      qty: removedDisposal,
      unit: "枚",
      unitYen: rates.panelDisposalYen,
      amountYen: removedDisposal * rates.panelDisposalYen,
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
    // 周辺機器（監視装置など）
    ...(input.extraLines ?? []).map((e) => ({
      label: e.label,
      qty: e.count,
      unit: "式",
      unitYen: e.unitYen,
      amountYen: e.count * e.unitYen,
    })),
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

/**
 * 標準的な年間発電量（1kWあたり）。純新設で現況比が取れないときの概算に使う。
 * 日本の低圧～高圧太陽光のおおよその実績（地域・傾斜で変動）。実値があれば上書き推奨。
 */
export const DEFAULT_SPECIFIC_YIELD_KWH_PER_KW = 1200;

/**
 * 変更後の年間発電量を推定する。
 *   既設あり（beforeKw>0）：現況発電量 × 後容量/前容量（容量比でスケール）。
 *   純新設（beforeKw<=0）：現況比が取れないので 後容量 × 標準日射量 で概算。
 */
export function estimateAfterGeneration(
  currentAnnualKwh: number,
  beforeKw: number,
  afterKw: number,
  specificYieldKwhPerKw: number = DEFAULT_SPECIFIC_YIELD_KWH_PER_KW
): number {
  if (beforeKw <= 0) return Math.max(0, afterKw) * specificYieldKwhPerKw;
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
