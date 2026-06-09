import type { PanelSpec, PcsSpec, DesignConditions } from "../types";

const STC_TEMP_C = 25;

/** 低温時の Voc（℃補正後）。低温で Voc は上昇するため最大直列数の制約になる。 */
export function vocAtTemp(panel: PanelSpec, tempC: number): number {
  const delta = tempC - STC_TEMP_C;
  return panel.vocV * (1 + (panel.tempCoeffVocPctPerC / 100) * delta);
}

/** 高温時の Vmp（℃補正後）。高温で Vmp は低下するため最小直列数の制約になる。 */
export function vmpAtTemp(panel: PanelSpec, tempC: number): number {
  const delta = tempC - STC_TEMP_C;
  // Vmp 専用係数が無ければ Pmax 係数 → Voc 係数の順でフォールバック
  const coeff =
    panel.tempCoeffPmaxPctPerC ?? panel.tempCoeffVocPctPerC;
  return panel.vmpV * (1 + (coeff / 100) * delta);
}

export interface StringSizingResult {
  /** 最大直列数（PCS 最大入力電圧 / 低温 Voc） */
  seriesMaxByVoltage: number;
  /** 最小直列数（MPPT 下限電圧 / 高温 Vmp） */
  seriesMinByMppt: number;
  /** 起動電圧を満たす最小直列数（任意） */
  seriesMinByStartup: number | null;
  /** 推奨直列数の下限・上限（上記制約の交差範囲） */
  seriesRange: { min: number; max: number };
  /** 1 MPPT あたり最大並列数（電流制約 と ハード上限 の小さい方） */
  parallelMaxPerMppt: number;
  /** 電流制約による並列上限（PCS 最大入力電流 / パネル Isc） */
  parallelMaxByCurrent: number;
  /** 計算根拠の数値 */
  detail: {
    vocLowTemp: number;
    vmpHighTemp: number;
  };
  /** 警告メッセージ（設計不成立・注意点） */
  warnings: string[];
}

/**
 * パネル × パワコン × 設計条件 から、ストリングの直列数・並列数の
 * 取りうる範囲を算出する。
 */
export function calcStringSizing(
  panel: PanelSpec,
  pcs: PcsSpec,
  cond: DesignConditions
): StringSizingResult {
  const warnings: string[] = [];

  const vocLow = vocAtTemp(panel, cond.minAmbientTempC);
  const vmpHigh = vmpAtTemp(panel, cond.maxCellTempC);

  // --- 直列数（電圧制約） ---
  // 上限: 低温 Voc の直列合計が PCS 最大入力電圧を超えない
  const seriesMaxByVoltage = Math.floor(pcs.maxInputVoltageV / vocLow);
  // 下限: 高温 Vmp の直列合計が MPPT 動作電圧下限を下回らない
  const seriesMinByMppt = Math.ceil(pcs.mpptVoltageMinV / vmpHigh);
  // 起動電圧（任意）
  const seriesMinByStartup =
    pcs.startVoltageV != null
      ? Math.ceil(pcs.startVoltageV / vmpHigh)
      : null;

  const seriesMin = Math.max(
    seriesMinByMppt,
    seriesMinByStartup ?? 0
  );
  const seriesMax = seriesMaxByVoltage;

  if (seriesMax < 1) {
    warnings.push(
      `パネル1枚の低温Voc(${vocLow.toFixed(1)}V)がPCS最大入力電圧(${pcs.maxInputVoltageV}V)を超えています。このパネルは直列できません。`
    );
  }
  if (seriesMin > seriesMax) {
    warnings.push(
      `直列数の下限(${seriesMin})が上限(${seriesMax})を上回り、適合する直列数がありません。パネルかPCSの組合せを見直してください。`
    );
  }

  // MPPT 上限電圧（動作範囲）に対する注意（必須制約ではなく効率上の目安）
  const vmpStcSeriesMax = (panel.vmpV * seriesMax);
  if (vmpStcSeriesMax > pcs.mpptVoltageMaxV) {
    warnings.push(
      `直列${seriesMax}本のSTC動作電圧(${vmpStcSeriesMax.toFixed(0)}V)がMPPT上限(${pcs.mpptVoltageMaxV}V)を超える運転点があり得ます。発電量低下に注意。`
    );
  }

  // --- 並列数（電流制約） ---
  const parallelMaxByCurrent = Math.floor(
    pcs.maxInputCurrentPerMpptA / panel.iscA
  );
  const parallelMaxPerMppt = Math.min(
    parallelMaxByCurrent,
    pcs.stringsPerMppt
  );
  if (parallelMaxPerMppt < 1) {
    warnings.push(
      `パネルIsc(${panel.iscA}A)がMPPT最大入力電流(${pcs.maxInputCurrentPerMpptA}A)を超え、並列できません。`
    );
  }

  return {
    seriesMaxByVoltage,
    seriesMinByMppt,
    seriesMinByStartup,
    seriesRange: { min: seriesMin, max: Math.max(seriesMax, 0) },
    parallelMaxPerMppt: Math.max(parallelMaxPerMppt, 0),
    parallelMaxByCurrent,
    detail: { vocLowTemp: vocLow, vmpHighTemp: vmpHigh },
    warnings,
  };
}

export interface ArrayCapacity {
  /** PCS 1台あたり接続可能な最大パネル枚数（全MPPT合計） */
  maxPanelsPerPcs: number;
  /** その時の DC 容量 (kW) */
  maxDcKw: number;
  /** 過積載率 DC/AC (%) */
  overloadPct: number;
}

/**
 * 推奨直列数 series を採用したときの、PCS 1 台あたりの最大構成と過積載率。
 */
export function calcArrayCapacity(
  panel: PanelSpec,
  pcs: PcsSpec,
  series: number,
  parallelPerMppt: number
): ArrayCapacity {
  const stringsTotal = parallelPerMppt * pcs.mpptCount;
  const maxPanels = series * stringsTotal;
  const maxDcKw = (maxPanels * panel.pmaxW) / 1000;
  const overloadPct =
    pcs.ratedPowerKw > 0 ? (maxDcKw / pcs.ratedPowerKw) * 100 : 0;
  return { maxPanelsPerPcs: maxPanels, maxDcKw, overloadPct };
}
