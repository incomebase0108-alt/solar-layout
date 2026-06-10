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
  /** DC 容量 (kW) */
  dcKw: number;
  /** 過積載率 DC/AC (%) */
  overloadPct: number;
  /** 影ゾーンのパワコンか */
  isShaded: boolean;
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
  /** 平均過積載率 (%) */
  avgOverloadPct: number;
  /** 最小・最大過積載率 (%) */
  minOverloadPct: number;
  maxOverloadPct: number;
  warnings: string[];
}

/**
 * total 個を bins 個へ、1 個ずつ順番に（ラウンドロビン）詰めて均等配分する。
 * 各 bin は cap を上限とする。戻り値は各 bin の個数。
 */
function spreadEven(total: number, bins: number, cap: number): number[] {
  const counts = new Array(bins).fill(0);
  if (bins <= 0) return counts;
  let remaining = Math.min(total, bins * cap);
  let i = 0;
  let guard = 0;
  while (remaining > 0 && guard < total + bins * cap + 1) {
    if (counts[i] < cap) {
      counts[i]++;
      remaining--;
    }
    i = (i + 1) % bins;
    guard++;
  }
  return counts;
}

function buildPcs(
  startIndex: number,
  stringCounts: number[],
  mpptCount: number,
  parallelPerMppt: number,
  series: number,
  panelW: number,
  ratedKw: number,
  isShaded: boolean
): PcsAssignment[] {
  return stringCounts.map((strings, k) => {
    const perMppt = spreadEven(strings, mpptCount, parallelPerMppt);
    const mppts: MpptAssignment[] = perMppt.map((s, m) => ({
      mpptIndex: m + 1,
      strings: s,
      panels: s * series,
    }));
    const totalPanels = strings * series;
    const dcKw = (totalPanels * panelW) / 1000;
    const overloadPct = ratedKw > 0 ? (dcKw / ratedKw) * 100 : 0;
    return {
      pcsIndex: startIndex + k,
      mppts,
      totalStrings: strings,
      totalPanels,
      dcKw,
      overloadPct,
      isShaded,
    };
  });
}

/**
 * 総パネル枚数を、直列数・MPPTあたり並列数・パワコン仕様に従って
 * パワコン／MPPT へ「なるべく均等」に割り付け、配線表データを生成する。
 *
 * - ルール: 同一系統（ストリング）は同一パネル・同一直列数。
 * - 影ゾーン: shadedPcsCount 台のパワコンは負荷率 shadeFactor まで下げ、
 *   余りのストリングは通常台が負担する（影側の過積載率を下げる）。
 */
export function generateWiring(
  panel: PanelSpec,
  pcs: PcsSpec,
  series: number,
  parallelPerMppt: number,
  totalPanels: number,
  shadedPcsCount = 0,
  shadeFactor = 0.7
): WiringResult {
  const warnings: string[] = [];

  if (series < 1 || parallelPerMppt < 1 || totalPanels < 1) {
    return {
      pcsCount: 0, totalStrings: 0, usedPanels: 0, leftoverPanels: totalPanels,
      series, perPcs: [], avgOverloadPct: 0, minOverloadPct: 0, maxOverloadPct: 0,
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

  const maxPerPcs = pcs.mpptCount * parallelPerMppt;
  if (maxPerPcs < 1) {
    return {
      pcsCount: 0, totalStrings, usedPanels, leftoverPanels, series,
      perPcs: [], avgOverloadPct: 0, minOverloadPct: 0, maxOverloadPct: 0,
      warnings: [...warnings, "このパワコンに接続可能なストリングがありません。"],
    };
  }

  // 影ゾーンのパワコンは容量を shadeFactor まで下げる
  const shaded = Math.max(0, Math.min(shadedPcsCount, 99));
  const shadedCap = Math.max(1, Math.min(maxPerPcs, Math.round(maxPerPcs * shadeFactor)));

  // 影側にまず詰め、残りを通常台へ
  const stringsOnShaded = shaded > 0 ? Math.min(totalStrings, shaded * shadedCap) : 0;
  const stringsOnNormal = totalStrings - stringsOnShaded;
  const normalPcsCount = Math.ceil(stringsOnNormal / maxPerPcs);

  const panelW = panel.pmaxW;
  const ratedKw = pcs.ratedPowerKw;

  const perPcs: PcsAssignment[] = [];

  // 通常台（均等）
  if (normalPcsCount > 0) {
    const counts = spreadEven(stringsOnNormal, normalPcsCount, maxPerPcs);
    perPcs.push(
      ...buildPcs(1, counts, pcs.mpptCount, parallelPerMppt, series, panelW, ratedKw, false)
    );
  }
  // 影ゾーン台（均等, 低負荷）
  if (shaded > 0 && stringsOnShaded > 0) {
    const counts = spreadEven(stringsOnShaded, shaded, shadedCap);
    perPcs.push(
      ...buildPcs(perPcs.length + 1, counts, pcs.mpptCount, parallelPerMppt, series, panelW, ratedKw, true)
    );
  }

  const overloads = perPcs.map((p) => p.overloadPct).filter((_, i) => perPcs[i].totalStrings > 0);
  const avgOverloadPct =
    overloads.length ? overloads.reduce((s, v) => s + v, 0) / overloads.length : 0;
  const minOverloadPct = overloads.length ? Math.min(...overloads) : 0;
  const maxOverloadPct = overloads.length ? Math.max(...overloads) : 0;

  if (maxOverloadPct > 130) {
    warnings.push(
      `最大過積載率が ${maxOverloadPct.toFixed(0)}% と高めです（目安 110–130%）。`
    );
  }

  return {
    pcsCount: perPcs.length,
    totalStrings,
    usedPanels,
    leftoverPanels,
    series,
    perPcs,
    avgOverloadPct,
    minOverloadPct,
    maxOverloadPct,
    warnings,
  };
}
