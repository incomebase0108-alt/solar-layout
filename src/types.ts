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
  /**
   * マルチMPPT（独立MPPT）機能の有無。
   * true=各MPPTが独立追従＝入力ごとに別パネル/別枚数でも可。
   * false=非独立＝全ストリングを同一パネル・同一直列数にしないと非効率。
   * 未指定は true 扱い。
   */
  multiMppt?: boolean;
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
  /** パネル間の隙間（横方向＝列の左右, m）。両面の桁間など。 */
  gapM: number;
  /** パネル間の隙間（縦方向＝行の前後, m）。未指定なら gapM を使う。両面の列間（アレイ離隔）用。 */
  gapYm?: number;
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
  /**
   * 撤去したセル（空き）のキー一覧。"行,列"。
   * フェンス離隔などで取り外した位置。枚数にカウントしない。
   */
  removedCells?: string[];
  /**
   * セルごとのパネル型式上書き。"行,列" → panelId。
   * 同サイズの別機種が1枚ずつ混在する場合に使う。未指定セルは panelId を使う。
   */
  cellPanels?: Record<string, string>;
}

/**
 * 単独パネル（配列とは別に1枚ずつ置けるパネル）。
 * 向きを個別に選べ、増設や端部の調整に使う。
 */
export interface FreePanel {
  id: string;
  panelId: string;
  orientation: "portrait" | "landscape";
  posXpx: number;
  posYpx: number;
  rotationDeg: number;
  color: string;
}

/** セルキー生成 */
export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

/** 配列の有効ギャップ(m)。gx=横（列の左右）, gy=縦（行の前後, 未指定は gx と同じ）。 */
export function arrayGaps(a: PanelArray): { gx: number; gy: number } {
  return { gx: a.gapM, gy: a.gapYm ?? a.gapM };
}

/**
 * 影ゾーン：画像ピクセル座標の矩形（軸並行）。
 * この中に入るパネルセルを「影」と判定する。
 */
export interface ShadowZone {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
}

/** 結線図の手編集による上書き（セルを指定の PC-ストリング-並列 に固定）。 */
export interface WiringOverride {
  pcsNo: number;
  stringNo: number;
  parallelNo: number;
}

/**
 * 図面の凡例（状況説明）の1行。色見本＋説明文。
 * 例: 緑＝トリナ360W 150枚 既設 横 / 青＝トリナ645W 20枚 新設 横
 */
export interface LegendItem {
  id: string;
  /** 色見本（#RRGGBB） */
  color: string;
  /** 説明文 */
  label: string;
}

/**
 * パネル構成のまとめ（枚数・出力）。基準スナップショットや現在値の集計に使う。
 */
export interface LayoutSummary {
  totalPanels: number;
  totalKw: number;
  /** パネル型式ごとの内訳 */
  byPanel: { model: string; count: number; kw: number }[];
}

/**
 * 現状の基準スナップショット。登録時点の構成を凍結保存し、改修案と前後比較する。
 */
export interface LayoutBaseline extends LayoutSummary {
  /** 登録日時(ミリ秒) */
  registeredAt: number;
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
  /** 影ゾーン（任意） */
  shadowZones?: ShadowZone[];
  /** 単独パネル（1枚ずつ追加, 任意） */
  freePanels?: FreePanel[];
  /** 現状の基準スナップショット（任意）。改修案との前後比較用。 */
  baseline?: LayoutBaseline | null;
  /** 図面の凡例・状況説明（任意）。写真の下に表示。 */
  legend?: LegendItem[];
  /** 結線図の手編集上書き（任意）。key=`${arrayId}:${r},${c}`。 */
  wiringOverrides?: Record<string, WiringOverride>;
  /** 現状を手入力で登録する場合のパネル一覧（任意）。複雑な発電所でレイアウト省略用。 */
  manualCurrent?: { id: string; panelId: string; count: number }[];
}

export const EMPTY_LAYOUT: LayoutProject = {
  imageDataUrl: null,
  imageRotationDeg: 0,
  imageOpacity: 1,
  calibration: null,
  arrays: [],
  shadowZones: [],
  freePanels: [],
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
  /**
   * 影ゾーンに入るパワコンの台数。
   * この台数分のパワコンは負荷率を下げて配分する（過積載率を下げる）。
   */
  shadedPcsCount: number;
  /**
   * 影ゾーンのパワコンの目標負荷率 (0–1)。
   * 1台あたり最大ストリング数に対する割合。小さいほど過積載率が下がる。
   */
  shadeFactor: number;
}

export interface PowerPlant {
  id: string;
  /** 発電所名 */
  name: string;
  /** 顧客名 */
  customerName?: string;
  /** 所在地 */
  address?: string;
  /** 連系容量などの備考 */
  note?: string;
  /**
   * パネル出力(DC)の上限 (kW)。FIT買取価格区分を超えないための上限。
   * null / 0 なら上限なし。最適化・配線でこれを超えると警告する。
   */
  outputCapKw?: number | null;
  /** FIT買取単価 (円/kWh) — 費用対効果用 */
  fitPriceYenPerKwh?: number | null;
  /** FIT残存年数 (年) — 費用対効果用 */
  fitRemainingYears?: number | null;
  /** 現在の年間発電量 (kWh/年) — 費用対効果用 */
  annualGenerationKwh?: number | null;
  createdAt: number;
  /** 図面（現況レイアウト） */
  layout: LayoutProject;
  /** 配線設定 */
  wiring: WiringPlan;
  /** パワコン構成（機種混在・台数指定）。任意。 */
  pcsUnits?: PcsUnitLine[];
}

/**
 * パワコンのストリング（MPPT入力）1本。
 * パネル混在可。直列数×並列で枚数、直列数×Vmp で合計電圧。
 */
export interface PcsString {
  id: string;
  /** 使用パネルマスタ id */
  panelId: string;
  /** 直列数（数量） */
  series: number;
  /** 並列数（本数）。既定1。 */
  parallel: number;
}

/**
 * パワコン構成の1グループ。機種＋台数＋ストリング構成を持つ。
 * 同一機種10台でも、別機種を複数グループで組み合わせてもよい。
 * グループ内の各台は同じストリング構成（strings）を共有する。
 */
export interface PcsUnitLine {
  id: string;
  /** 参照するパワコンマスタ id */
  pcsId: string;
  /** 台数（このストリング構成の台数） */
  count: number;
  /** メモ（任意, 例:「南面用」「影区画用」） */
  note?: string;
  /** 1台あたりのストリング構成（任意）。未指定なら台数×ACのみ集計。 */
  strings?: PcsString[];
}

export const EMPTY_WIRING: WiringPlan = {
  pcsId: null,
  panelId: null,
  seriesPerString: 0,
  parallelPerMppt: 0,
  totalPanelsOverride: null,
  allowMixedPanelSeries: false,
  shadedPcsCount: 0,
  shadeFactor: 0.7,
};

// ============================================================
// 概算コスト用の単価設定（工事費・諸経費率）
//   材料費はマスタの unitPriceYen、工事費はここの設定を使う。
//   値は編集前提の目安プレースホルダ。
// ============================================================
export interface CostRates {
  /** 既設パネル撤去（取り外し工事, 円/枚）。処分/在庫とも共通でかかる。 */
  panelRemovalYen: number;
  /** 既設パネル処分費 (円/枚)。処分に回す分だけにかかる（在庫は不要）。 */
  panelDisposalYen: number;
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
  panelDisposalYen: 2000,
  panelInstallYen: 8000,
  pcsRemovalYen: 15000,
  pcsInstallYen: 30000,
  miscRatePct: 10,
};
