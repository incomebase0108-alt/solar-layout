import type { PanelSpec, PcsSpec, DesignConditions } from "../types";
import { calcStringSizing } from "./stringSizing";

export interface CapacityCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export type Verdict = "ok" | "rework" | "infeasible";

export interface ExistingPcsResult {
  /** 必要ストリング数 = floor(総枚数 / 直列数) */
  neededStrings: number;
  /** 既設パワコンの総入力系統数 = 台数 × MPPT数 × MPPTあたり最大並列数 */
  totalSlots: number;
  /** 空き系統数 */
  freeSlots: number;
  /** MPPTあたり使用電流 (A) = 並列数 × Isc */
  usedCurrentA: number;
  currentLimitA: number;
  currentMarginA: number;
  /** 接続DC容量 (kW) */
  connectedDcKw: number;
  /** 既設パワコン合計AC (kW) */
  acKw: number;
  overloadPct: number;
  /** 目標過積載率まであと何kW載せられるか */
  overloadHeadroomKw: number;
  /** 許容直列数の範囲 */
  seriesRange: { min: number; max: number };
  checks: CapacityCheck[];
  verdict: Verdict;
  verdictLabel: string;
}

/**
 * 既設パワコンに計画パネルが収まるかを多面的に判定する。
 *   ① 直列数が電圧範囲に収まるか
 *   ② MPPTあたり電流が上限内か
 *   ③ 入力系統（スロット）が足りるか
 *   ④ 過積載率が目標上限内か
 */
export function checkExistingPcs(
  panel: PanelSpec,
  pcs: PcsSpec,
  pcsCount: number,
  series: number,
  parallelPerMppt: number,
  totalPanels: number,
  conditions: DesignConditions,
  overloadCapPct = 130
): ExistingPcsResult {
  const sizing = calcStringSizing(panel, pcs, conditions);
  const seriesRange = sizing.seriesRange;

  const neededStrings = series > 0 ? Math.floor(totalPanels / series) : 0;
  const totalSlots = pcsCount * pcs.mpptCount * pcs.stringsPerMppt;
  const freeSlots = totalSlots - neededStrings;

  const usedCurrentA = parallelPerMppt * panel.iscA;
  const currentLimitA = pcs.maxInputCurrentPerMpptA;
  const currentMarginA = currentLimitA - usedCurrentA;

  const usedPanels = neededStrings * series;
  const connectedDcKw = (usedPanels * panel.pmaxW) / 1000;
  const acKw = pcsCount * pcs.ratedPowerKw;
  const overloadPct = acKw > 0 ? (connectedDcKw / acKw) * 100 : 0;
  const overloadHeadroomKw = (overloadCapPct / 100) * acKw - connectedDcKw;

  const seriesValidExists = seriesRange.max >= seriesRange.min && seriesRange.max >= 1;
  const seriesOk = seriesValidExists && series >= seriesRange.min && series <= seriesRange.max;
  const currentOk = currentLimitA > 0 && usedCurrentA <= currentLimitA + 1e-9;
  const parallelSlotOk = parallelPerMppt <= pcs.stringsPerMppt;
  const slotsOk = neededStrings <= totalSlots;
  const overloadOk = overloadPct <= overloadCapPct + 1e-9;

  const checks: CapacityCheck[] = [
    {
      label: "直列数（電圧範囲）",
      ok: seriesOk,
      detail: seriesValidExists
        ? `計画 ${series} 直列／許容 ${seriesRange.min}–${seriesRange.max} 直列`
        : "この組合せで成立する直列数がありません",
    },
    {
      label: "MPPT入力電流",
      ok: currentOk,
      detail: `使用 ${usedCurrentA.toFixed(1)}A（${parallelPerMppt}並列×Isc${panel.iscA}）／上限 ${currentLimitA}A・余裕 ${currentMarginA.toFixed(1)}A`,
    },
    {
      label: "MPPTあたり並列数",
      ok: parallelSlotOk,
      detail: `計画 ${parallelPerMppt} 並列／MPPT上限 ${pcs.stringsPerMppt} 並列`,
    },
    {
      label: "入力系統（空き）",
      ok: slotsOk,
      detail: `必要 ${neededStrings} 系統／既設 ${totalSlots} 系統（${pcsCount}台）・${slotsOk ? `空き ${freeSlots}` : `不足 ${-freeSlots}`} 系統`,
    },
    {
      label: "過積載率",
      ok: overloadOk,
      detail: `${overloadPct.toFixed(0)}%（上限 ${overloadCapPct}%）・余裕 ${overloadHeadroomKw.toFixed(1)}kW`,
    },
  ];

  // 判定
  let verdict: Verdict;
  if (!seriesValidExists || !slotsOk) {
    verdict = "infeasible"; // 直列不成立 or 系統不足 → 既設では収まらない
  } else if (seriesOk && currentOk && parallelSlotOk && overloadOk) {
    verdict = "ok";
  } else {
    verdict = "rework"; // 設定調整（直列/並列/枚数）で流用可
  }

  const verdictLabel =
    verdict === "ok"
      ? "流用OK"
      : verdict === "rework"
      ? "要組み替え（設定調整で流用可）"
      : "流用不可（増設/新設が必要）";

  return {
    neededStrings,
    totalSlots,
    freeSlots,
    usedCurrentA,
    currentLimitA,
    currentMarginA,
    connectedDcKw,
    acKw,
    overloadPct,
    overloadHeadroomKw,
    seriesRange,
    checks,
    verdict,
    verdictLabel,
  };
}
