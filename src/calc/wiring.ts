import type { PanelSpec, PcsSpec } from "../types";

export interface MpptAssignment {
  mpptIndex: number; // 1-based
  strings: number; // この MPPT に接続するストリング(並列)数
  panels: number; // = strings * series
}

export interface PcsAssignment {
  pcsIndex: number; // 1-based（同一機種の何台目か）
  mppts: MpptAssignment[];
  totalStrings: number;
  totalPanels: number;
}

export interface WiringResult {
  /** パワコン台数 */
  pcsCount: number;
  /** ストリング総数 */
  totalStrings: number;
  /** 配線に使うパネル枚数 */
  usedPanels: number;
  /** 余り（割り切れず未接続のパネル） */
  leftoverPanels: number;
  /** 1直列あたりの枚数 */
  series: number;
  /** パワコンごとの割付 */
  perPcs: PcsAssignment[];
  warnings: string[];
}

/**
 * 総パネル枚数を、直列数・MPPTあたり並列数・パワコン仕様に従って
 * パワコン／MPPT へ均等に割り付け、配線表データを生成する。
 *
 * ルール: 同一系統（ストリング）は同一パネル・同一直列数。
 */
export function generateWiring(
  panel: PanelSpec,
  pcs: PcsSpec,
  series: number,
  parallelPerMppt: number,
  totalPanels: number
): WiringResult {
  const warnings: string[] = [];

  if (series < 1 || parallelPerMppt < 1 || totalPanels < 1) {
    return {
      pcsCount: 0,
      totalStrings: 0,
      usedPanels: 0,
      leftoverPanels: totalPanels,
      series,
      perPcs: [],
      warnings: ["直列数・並列数・総枚数を設定してください。"],
    };
  }

  if (parallelPerMppt > pcs.stringsPerMppt) {
    warnings.push(
      `並列数 ${parallelPerMppt} が MPPTあたり最大 ${pcs.stringsPerMppt} を超えています。`
    );
  }

  const totalStrings = Math.floor(totalPanels / series);
  const usedPanels = totalStrings * series;
  const leftoverPanels = totalPanels - usedPanels;
  if (leftoverPanels > 0) {
    warnings.push(
      `${leftoverPanels} 枚が直列数 ${series} で割り切れず未接続です（半端分）。`
    );
  }

  // MPPT あたり parallelPerMppt 本、PCS あたり mpptCount 個の MPPT
  const stringsPerPcs = pcs.mpptCount * parallelPerMppt;
  if (stringsPerPcs < 1) {
    return {
      pcsCount: 0,
      totalStrings,
      usedPanels,
      leftoverPanels,
      series,
      perPcs: [],
      warnings: [...warnings, "このパワコンに接続可能なストリングがありません。"],
    };
  }

  const perPcs: PcsAssignment[] = [];
  let remaining = totalStrings;
  let pcsIndex = 1;

  while (remaining > 0) {
    const mppts: MpptAssignment[] = [];
    let pcsStrings = 0;
    for (let m = 1; m <= pcs.mpptCount && remaining > 0; m++) {
      const s = Math.min(parallelPerMppt, remaining);
      mppts.push({ mpptIndex: m, strings: s, panels: s * series });
      remaining -= s;
      pcsStrings += s;
    }
    perPcs.push({
      pcsIndex,
      mppts,
      totalStrings: pcsStrings,
      totalPanels: pcsStrings * series,
    });
    pcsIndex++;
  }

  // 過積載率の参考警告
  const dcKw = (usedPanels * panel.pmaxW) / 1000;
  const acKw = perPcs.length * pcs.ratedPowerKw;
  if (acKw > 0) {
    const overload = (dcKw / acKw) * 100;
    if (overload > 130) {
      warnings.push(
        `全体の過積載率が ${overload.toFixed(0)}% と高めです（目安 110–130%）。`
      );
    }
  }

  return {
    pcsCount: perPcs.length,
    totalStrings,
    usedPanels,
    leftoverPanels,
    series,
    perPcs,
    warnings,
  };
}
