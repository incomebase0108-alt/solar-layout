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
