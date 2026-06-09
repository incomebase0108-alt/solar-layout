// ============================================================
// データモデル定義
// ============================================================

/**
 * 太陽光パネル（モジュール）マスタ
 * 寸法はレイアウト計算に、電気特性はストリング設計に使用する。
 */
export interface PanelSpec {
  id: string;
  /** メーカー名 */
  maker: string;
  /** 型番 */
  model: string;

  // --- 寸法（レイアウト用, 単位 mm） ---
  /** 長辺方向の長さ mm（縦置き時の高さ） */
  lengthMm: number;
  /** 短辺方向の長さ mm（縦置き時の幅） */
  widthMm: number;
  /** 厚さ mm（任意） */
  thicknessMm?: number;
  /** 重量 kg（任意, 荷重検討用） */
  weightKg?: number;

  // --- 電気特性（STC, ストリング設計用） ---
  /** 公称最大出力 Pmax (W) */
  pmaxW: number;
  /** 最大動作電圧 Vmp (V) */
  vmpV: number;
  /** 最大動作電流 Imp (A) */
  impA: number;
  /** 開放電圧 Voc (V) */
  vocV: number;
  /** 短絡電流 Isc (A) */
  iscA: number;

  // --- 温度特性（ストリング電圧の温度補正用, %/℃） ---
  /** Voc の温度係数 β (%/℃, 通常マイナス) 例: -0.27 */
  tempCoeffVocPctPerC: number;
  /** Pmax の温度係数 (%/℃, 通常マイナス) 例: -0.34 */
  tempCoeffPmaxPctPerC?: number;

  /** 備考 */
  note?: string;
}

/**
 * パワーコンディショナ（PCS）マスタ
 * 既設流用・新設の区別を持ち、MPPT 仕様からストリング数を計算する。
 */
export interface PcsSpec {
  id: string;
  /** メーカー名 */
  maker: string;
  /** 型番 */
  model: string;
  /** 既設流用 or 新設 */
  kind: "existing" | "new";

  // --- AC 側 ---
  /** 定格出力 (kW) */
  ratedPowerKw: number;

  // --- DC 入力側 ---
  /** MPPT 回路数 */
  mpptCount: number;
  /** 1 MPPT あたりの最大入力（並列）数 */
  stringsPerMppt: number;
  /** 最大入力電圧 Vdc,max (V) — これを超えてはならない上限 */
  maxInputVoltageV: number;
  /** MPPT 動作電圧範囲 下限 (V) */
  mpptVoltageMinV: number;
  /** MPPT 動作電圧範囲 上限 (V) */
  mpptVoltageMaxV: number;
  /** 起動電圧 (V, 任意) */
  startVoltageV?: number;
  /** 1 MPPT あたりの最大入力電流 (A) */
  maxInputCurrentPerMpptA: number;

  /** 備考 */
  note?: string;
}

/**
 * ストリング設計の前提条件（現地の温度条件など）
 */
export interface DesignConditions {
  /** 設計最低気温 (℃) — Voc 最大（低温）側の評価に使用 */
  minAmbientTempC: number;
  /** 設計最高セル温度 (℃) — Vmp 最小（高温）側の評価に使用 */
  maxCellTempC: number;
}

export const DEFAULT_CONDITIONS: DesignConditions = {
  minAmbientTempC: -10,
  maxCellTempC: 70,
};
