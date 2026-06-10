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

  /** 単価（円/枚, 任意）— 概算コスト用 */
  unitPriceYen?: number;

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

  /** 単価（円/台, 任意）— 概算コスト用 */
  unitPriceYen?: number;

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

// ============================================================
// 現況レイアウト（航空写真トレース）用モデル
// ============================================================

/**
 * スケール校正：画像ピクセル上の 2 点と、その実長(m)。
 * これから「1m あたり何ピクセルか」を求める。
 */
export interface Calibration {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 上記 2 点間の実際の距離 (m) */
  meters: number;
}

/**
 * パネル配列（架台 1 ブロック）。
 * 画像ピクセル座標系で位置を持ち、行×列でグリッド配置する。
 */
export interface PanelArray {
  id: string;
  /** 参照するパネルマスタ id（寸法取得用） */
  panelId: string;
  /** 縦置き / 横置き */
  orientation: "portrait" | "landscape";
  rows: number;
  cols: number;
  /** パネル間の隙間 (m) */
  gapM: number;
  /** 配列左上の画像ピクセル座標 */
  posXpx: number;
  posYpx: number;
  /** 画像に対する配列の回転 (度) */
  rotationDeg: number;
  /** 表示色 */
  color: string;
  /**
   * 「流用（変更しない）」パネルのセルキー一覧。"行,列"（0始まり）。
   * 既定は空＝全セル入換対象。ここに入ったセルは既設流用。
   */
  keepCells?: string[];
}

/** セルキー生成 */
export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

/**
 * 現況レイアウトのプロジェクト（写真＋校正＋配列）。
 */
export interface LayoutProject {
  /** 背景航空写真（データURL, アップロード時に縮小） */
  imageDataUrl: string | null;
  /** 写真の向き補正（度）— ご要望の「向きを変える」機能 */
  imageRotationDeg: number;
  /** 背景の透過度 0–1 */
  imageOpacity: number;
  /** スケール校正 */
  calibration: Calibration | null;
  /** 配置済みパネル配列 */
  arrays: PanelArray[];
}

export const EMPTY_LAYOUT: LayoutProject = {
  imageDataUrl: null,
  imageRotationDeg: 0,
  imageOpacity: 1,
  calibration: null,
  arrays: [],
};

// ============================================================
// 発電所（サイト）モデル
//   発電所ごとに 図面（現況レイアウト）と 配線設定 を持つ。
//   パネル/パワコンは共通マスタを参照する。
// ============================================================

/**
 * 配線設定：この発電所で採用するパワコンと、ストリング構成。
 * 「同一系統＝同一パネル」「パワコン仕様に合わせた直列/並列」を表す。
 */
export interface WiringPlan {
  /** 採用するパワコンマスタ id（既設/新設はマスタ側の kind で区別） */
  pcsId: string | null;
  /** 採用するパネルマスタ id（系統共通のパネル） */
  panelId: string | null;
  /** 1 ストリングあたりの直列数 */
  seriesPerString: number;
  /** 1 MPPT あたりの並列（ストリング）数 */
  parallelPerMppt: number;
  /** 設計対象の総パネル枚数（未指定なら図面の合計を使う） */
  totalPanelsOverride: number | null;
  /**
   * 直列(1系統)に異なるパネルの混在を許可するか。
   * 既定 false ＝「同一系統＝同一パネル」。
   * true のときのみ、流用パネルと新パネルを同一ストリングで組合せ可。
   */
  allowMixedPanelSeries: boolean;
}

export interface PowerPlant {
  id: string;
  /** 発電所名 */
  name: string;
  /** 所在地 */
  address?: string;
  /** 連系容量などの備考 */
  note?: string;
  /**
   * パネル出力(DC)の上限 (kW)。FIT買取価格区分を超えないための上限。
   * null / 0 なら上限なし。最適化・配線でこれを超えると警告する。
   */
  outputCapKw?: number | null;
  createdAt: number;
  /** 図面（現況レイアウト） */
  layout: LayoutProject;
  /** 配線設定 */
  wiring: WiringPlan;
}

export const EMPTY_WIRING: WiringPlan = {
  pcsId: null,
  panelId: null,
  seriesPerString: 0,
  parallelPerMppt: 0,
  totalPanelsOverride: null,
  allowMixedPanelSeries: false,
};

// ============================================================
// 概算コスト用の単価設定（工事費・諸経費率）
//   材料費はマスタの unitPriceYen、工事費はここの設定を使う。
//   値は編集前提の目安プレースホルダ。
// ============================================================
export interface CostRates {
  /** 既設パネル撤去 (円/枚) */
  panelRemovalYen: number;
  /** 新パネル設置工事 (円/枚) */
  panelInstallYen: number;
  /** 既設パワコン撤去 (円/台) */
  pcsRemovalYen: number;
  /** 新パワコン設置工事 (円/台) */
  pcsInstallYen: number;
  /** 諸経費率 (%) — 小計に対して加算 */
  miscRatePct: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  panelRemovalYen: 3000,
  panelInstallYen: 8000,
  pcsRemovalYen: 15000,
  pcsInstallYen: 30000,
  miscRatePct: 10,
};
