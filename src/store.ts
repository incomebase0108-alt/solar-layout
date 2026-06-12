import { useCallback, useEffect, useState } from "react";
import type {
  PanelSpec,
  PcsSpec,
  DesignConditions,
  LayoutProject,
  PowerPlant,
  WiringPlan,
  CostRates,
  PlanCandidate,
} from "./types";
import {
  DEFAULT_CONDITIONS,
  EMPTY_LAYOUT,
  EMPTY_WIRING,
  DEFAULT_COST_RATES,
} from "./types";

// ============================================================
// LocalStorage ベースの簡易永続化ストア
//   - マスタ（パネル / パワコン）と設計条件を保存する
//   - 将来 API/DB に差し替えやすいよう薄いフックに閉じ込める
// ============================================================

export const KEYS = {
  panels: "solar-layout.panels",
  pcs: "solar-layout.pcs",
  conditions: "solar-layout.conditions",
  layout: "solar-layout.layout",
  plants: "solar-layout.plants",
  currentPlant: "solar-layout.currentPlant",
  costRates: "solar-layout.costRates",
  /** 削除した初期搭載マスタ（seed）の id。これが無いと削除してもリロードで復活する。 */
  deletedSeeds: "solar-layout.deletedSeeds",
} as const;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as T;
    // "null" 等の不正値が書かれていた場合に白画面クラッシュしないよう fallback に倒す
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

let lastSaveAlertAt = 0;

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過などで保存に失敗すると、リロード時に最後に保存できた状態まで巻き戻る。
    // 黙って失敗すると気づけないため通知する（保存は頻発するので30秒に1回まで）。
    const now = Date.now();
    if (now - lastSaveAlertAt > 30_000) {
      lastSaveAlertAt = now;
      alert(
        "データを保存できませんでした（ブラウザの保存容量オーバーの可能性）。\n" +
          "このままでは最新の編集が残りません。不要な発電所や背景写真を削除して容量を空けるか、\n" +
          "念のため「バックアップを保存（JSON）」でファイルに退避してください。"
      );
    }
  }
}

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** 実機マスタ（初回のみ投入）。値はデータシート/spec DB から。要現物確認。 */
const SEED_PANELS: PanelSpec[] = [
  {
    id: "trina_de14a_360",
    maker: "Trina Solar",
    model: "TSM-360DE14A(II)",
    lengthMm: 1960,
    widthMm: 992,
    thicknessMm: 40,
    weightKg: 22.5,
    pmaxW: 360,
    vmpV: 38.8,
    impA: 9.28,
    vocV: 47.7,
    iscA: 9.7,
    tempCoeffVocPctPerC: -0.29,
    tempCoeffPmaxPctPerC: -0.37,
    note: "既設パネル（360W単結晶）",
  },
  {
    id: "trina_neg21c_700",
    maker: "Trina Solar",
    model: "TSM-700NEG21C.20",
    lengthMm: 2384,
    widthMm: 1303,
    thicknessMm: 33,
    weightKg: 38.3,
    pmaxW: 700,
    vmpV: 44.2,
    impA: 15.84,
    vocV: 52.5,
    iscA: 15.8,
    tempCoeffVocPctPerC: -0.25,
    tempCoeffPmaxPctPerC: -0.29,
    note: "候補（700W両面・N型TOPCon。2384×1303mmの大判=要再架台）",
  },
  {
    id: "sanix_srm296p_72n",
    maker: "SANIX",
    model: "SRM296P-72N",
    lengthMm: 1957,
    widthMm: 992,
    thicknessMm: 50,
    weightKg: 23,
    pmaxW: 296,
    vmpV: 36.6,
    impA: 8.09,
    vocV: 45.4,
    iscA: 8.74,
    tempCoeffVocPctPerC: -0.383,
    tempCoeffPmaxPctPerC: -0.5094,
    note: "サニックス・多結晶72セル(12×6)・296W・1957×992・最大システム電圧1000V",
  },
  // ===== 既設でよく出る既製パネル群（値はデータシート/スクショより。△は要確認） =====
  // Trina PC05A（多結晶60セル）
  {
    id: "trina_pc05a_255", maker: "Trina Solar", model: "TSM-255PC05A",
    lengthMm: 1650, widthMm: 992, thicknessMm: 35, weightKg: 18.6,
    pmaxW: 255, vmpV: 30, impA: 8.37, vocV: 38.1, iscA: 8.88,
    tempCoeffVocPctPerC: -0.32, tempCoeffPmaxPctPerC: -0.41, note: "多結晶60セル（Topsky製TSM-PC05A）",
  },
  {
    id: "trina_pc05a_250", maker: "Trina Solar", model: "TSM-250PC05A",
    lengthMm: 1650, widthMm: 992, thicknessMm: 35, weightKg: 18.6,
    pmaxW: 250, vmpV: 30.3, impA: 8.27, vocV: 38, iscA: 8.79,
    tempCoeffVocPctPerC: -0.32, tempCoeffPmaxPctPerC: -0.41, note: "多結晶60セル",
  },
  // Trina PD14（多結晶72セル）
  {
    id: "trina_pd14_320", maker: "Trina Solar", model: "TSM-320PD14",
    lengthMm: 1960, widthMm: 992, thicknessMm: 40, weightKg: 26.5,
    pmaxW: 320, vmpV: 37.1, impA: 8.63, vocV: 45.5, iscA: 9.15,
    tempCoeffVocPctPerC: -0.32, tempCoeffPmaxPctPerC: -0.41, note: "多結晶72セル",
  },
  // Trina DD05A.08（単結晶PERC 60セル）△推定
  {
    id: "trina_dd05a_300", maker: "Trina Solar", model: "TSM-300DD05A.08(II)",
    lengthMm: 1650, widthMm: 992, thicknessMm: 35, weightKg: 18.6,
    pmaxW: 300, vmpV: 32.6, impA: 9.19, vocV: 39.9, iscA: 9.64,
    tempCoeffVocPctPerC: -0.29, tempCoeffPmaxPctPerC: -0.39, note: "Honey M Plus 単結晶60セル",
  },
  // Hanwha Q CELLS
  {
    id: "qcells_qplus_lg41_340", maker: "Hanwha Q CELLS", model: "Q.PLUS L-G4.1 340",
    lengthMm: 1994, widthMm: 1000, thicknessMm: 35, weightKg: 24,
    pmaxW: 340, vmpV: 37.63, impA: 9.03, vocV: 47.07, iscA: 9.59,
    tempCoeffVocPctPerC: -0.30, tempCoeffPmaxPctPerC: -0.40, note: "多結晶72セル",
  },
  {
    id: "qcells_qpro_g3_255", maker: "Hanwha Q CELLS", model: "Q.PRO-G3 255",
    lengthMm: 1670, widthMm: 1000, thicknessMm: 35, weightKg: 19,
    pmaxW: 255, vmpV: 30.77, impA: 8.37, vocV: 37.83, iscA: 8.90,
    tempCoeffVocPctPerC: -0.30, tempCoeffPmaxPctPerC: -0.44, note: "多結晶60セル",
  },
  // Jinko 72セル単結晶
  {
    id: "jinko_jkm370m72j", maker: "Jinko Solar", model: "JKM370M-72-J",
    lengthMm: 1956, widthMm: 992, thicknessMm: 40, weightKg: 26.5,
    pmaxW: 370, vmpV: 39.9, impA: 9.28, vocV: 48.5, iscA: 9.61,
    tempCoeffVocPctPerC: -0.29, tempCoeffPmaxPctPerC: -0.39, note: "単結晶72セル",
  },
  {
    id: "jinko_jkm360m72j", maker: "Jinko Solar", model: "JKM360M-72-J",
    lengthMm: 1956, widthMm: 992, thicknessMm: 40, weightKg: 26.5,
    pmaxW: 360, vmpV: 39.5, impA: 9.12, vocV: 48.0, iscA: 9.51,
    tempCoeffVocPctPerC: -0.29, tempCoeffPmaxPctPerC: -0.39, note: "単結晶72セル",
  },
  // Jinko Cheetah HC 144ハーフセル △推定
  {
    id: "jinko_jkm400m72h", maker: "Jinko Solar", model: "JKM400M-72H",
    lengthMm: 2008, widthMm: 1002, thicknessMm: 40, weightKg: 22.5,
    pmaxW: 400, vmpV: 41.7, impA: 9.60, vocV: 49.8, iscA: 10.36,
    tempCoeffVocPctPerC: -0.29, tempCoeffPmaxPctPerC: -0.35, note: "Cheetah HC 144ハーフセル単結晶PERC",
  },
  {
    id: "jinko_jkm405m72h", maker: "Jinko Solar", model: "JKM405M-72H",
    lengthMm: 2008, widthMm: 1002, thicknessMm: 40, weightKg: 22.5,
    pmaxW: 405, vmpV: 42.0, impA: 9.65, vocV: 50.1, iscA: 10.48,
    tempCoeffVocPctPerC: -0.29, tempCoeffPmaxPctPerC: -0.35, note: "Cheetah HC 144ハーフセル単結晶PERC",
  },
  // Canadian Solar 多結晶60セル
  {
    id: "canadian_cs6p_255p", maker: "Canadian Solar", model: "CS6P-255P",
    lengthMm: 1638, widthMm: 982, thicknessMm: 40, weightKg: 18,
    pmaxW: 255, vmpV: 30.2, impA: 8.43, vocV: 37.4, iscA: 9.00,
    tempCoeffVocPctPerC: -0.34, tempCoeffPmaxPctPerC: -0.43, note: "多結晶60セル",
  },
  // JA Solar 156ハーフセル △STC推定
  {
    id: "jasolar_jam78s10_435mr", maker: "JA Solar", model: "JAM78S10-435/MR",
    lengthMm: 2180, widthMm: 996, thicknessMm: 40, weightKg: 24.6,
    pmaxW: 435, vmpV: 44.3, impA: 9.78, vocV: 53.6, iscA: 10.45,
    tempCoeffVocPctPerC: -0.275, tempCoeffPmaxPctPerC: -0.35, note: "MBB PERC 156ハーフセル(78セル直列)・Voc高め",
  },
  // LONGi 144ハーフセル
  {
    id: "longi_lr5_72hph_540m", maker: "LONGi", model: "LR5-72HPH-540M",
    lengthMm: 2256, widthMm: 1133, thicknessMm: 35, weightKg: 27.2,
    pmaxW: 540, vmpV: 41.6, impA: 12.98, vocV: 49.5, iscA: 13.85,
    tempCoeffVocPctPerC: -0.265, tempCoeffPmaxPctPerC: -0.34, note: "Hi-MO5 144ハーフセル単結晶",
  },
  // DMM 両面N型144ハーフセル
  {
    id: "dmm6_144ma_430dd", maker: "DMM.make solar", model: "DMM6-144MA-430DD",
    lengthMm: 2035, widthMm: 1006, thicknessMm: 30, weightKg: 25.9,
    pmaxW: 430, vmpV: 42.35, impA: 10.16, vocV: 50.54, iscA: 10.66,
    tempCoeffVocPctPerC: -0.30, tempCoeffPmaxPctPerC: -0.35, note: "両面発電N型144ハーフセル・両面ガラス",
  },
  // Hanwha Q.PEAK-G4.1 60セル単結晶
  {
    id: "qcells_qpeak_g41_300", maker: "Hanwha Q CELLS", model: "Q.PEAK-G4.1 300",
    lengthMm: 1670, widthMm: 1000, thicknessMm: 32, weightKg: 18.5,
    pmaxW: 300, vmpV: 32.41, impA: 9.26, vocV: 39.76, iscA: 9.77,
    tempCoeffVocPctPerC: -0.28, tempCoeffPmaxPctPerC: -0.39, note: "単結晶60セル（BLK-G4.1と同電気特性）",
  },
];

// 値はメーカー仕様書から。要現物・最新版確認（特に電流・電圧・回路数）。
const SEED_PCS: PcsSpec[] = [
  {
    id: "huawei_495_nhl2",
    maker: "Huawei",
    model: "SUN2000-4.95KTL-NHL2",
    kind: "new",
    ratedPowerKw: 4.95,
    mpptCount: 2,
    multiMppt: true,
    stringsPerMppt: 2,
    maxInputVoltageV: 600,
    mpptVoltageMinV: 90,
    mpptVoltageMaxV: 560,
    startVoltageV: 100,
    maxInputCurrentPerMpptA: 16,
    unitPriceYen: 75500,
    note: "8台構成 / 10回路入力・主幹ELCB付",
  },
  // === OMRON KPVシリーズ（よく選定される・4回路1MPPT＝マルチなし） ===
  {
    id: "omron_kpv_a55_j4",
    maker: "OMRON",
    model: "KPV-A55-J4",
    kind: "new",
    ratedPowerKw: 5.5,
    mpptCount: 1,
    multiMppt: false,
    stringsPerMppt: 4,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 40,
    note: "屋外・4回路1MPPT(非マルチ)・一般タイプ／定格入力320V。重塩害は KPV-A55-SJ4",
  },
  // === OMRON KPR-Aシリーズ（4MPPT＝マルチあり） ===
  {
    id: "omron_kpr_a48_j4",
    maker: "OMRON",
    model: "KPR-A48-J4",
    kind: "new",
    ratedPowerKw: 4.8,
    mpptCount: 4,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 12,
    note: "4MPPT(マルチ)・4.8kW。大電流型は KPR-A48-2J4(14A/回路)",
  },
  {
    id: "omron_kpr_a56_j4",
    maker: "OMRON",
    model: "KPR-A56-J4",
    kind: "new",
    ratedPowerKw: 5.6,
    mpptCount: 4,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 12,
    note: "4MPPT(マルチ)・5.6kW。大電流型は KPR-A56-2J4(14A/回路)",
  },
  // === OMRON KPWシリーズ（4回路1MPPT＝マルチなし） ===
  {
    id: "omron_kpw_a48_j4",
    maker: "OMRON",
    model: "KPW-A48-J4",
    kind: "new",
    ratedPowerKw: 4.8,
    mpptCount: 1,
    multiMppt: false,
    stringsPerMppt: 4,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 44,
    note: "4回路1MPPT(非マルチ)・4.8kW・一般タイプ",
  },
  {
    id: "omron_kpw_a55_j4",
    maker: "OMRON",
    model: "KPW-A55-J4",
    kind: "new",
    ratedPowerKw: 5.5,
    mpptCount: 1,
    multiMppt: false,
    stringsPerMppt: 4,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 44,
    note: "4回路1MPPT(非マルチ)・5.5kW・一般タイプ。重塩害は KPW-A55-SJ4",
  },
  // === OMRON KPW-A-2シリーズ（自家消費用・型式詳細は要確認） ===
  {
    id: "omron_kpw_a55_2",
    maker: "OMRON",
    model: "KPW-A55-2（自家消費用）",
    kind: "new",
    ratedPowerKw: 5.5,
    mpptCount: 1,
    multiMppt: false,
    stringsPerMppt: 4,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 50,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 44,
    note: "自家消費用KPW-A-2シリーズ・代表値。実際の型式/諸元は仕様書で要確認",
  },
  // === ダイヤゼブラ電機（EneTelus）EIBS No.8「エビハチ」蓄電ハイブリッド・単相 ===
  {
    id: "dz_eibs8_55",
    maker: "ダイヤゼブラ電機",
    model: "EHK-S55MP3B（EIBS No.8）",
    kind: "new",
    ratedPowerKw: 5.5,
    mpptCount: 3,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 30,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 13.5,
    note: "蓄電ハイブリッド(エビハチ)・単相5.5kW・3回路。蓄電池ユニット EOK-LB77-TK",
  },
  {
    id: "dz_eibs8_80",
    maker: "ダイヤゼブラ電機",
    model: "EHK-S80MP4B（EIBS No.8）",
    kind: "new",
    ratedPowerKw: 8.0,
    mpptCount: 4,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 30,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 13.5,
    note: "蓄電ハイブリッド(エビハチ)・単相8.0kW・4回路",
  },
  {
    id: "dz_eibs8_99",
    maker: "ダイヤゼブラ電機",
    model: "EHK-S99MP5B（EIBS No.8）",
    kind: "new",
    ratedPowerKw: 9.9,
    mpptCount: 5,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 450,
    mpptVoltageMinV: 30,
    mpptVoltageMaxV: 450,
    maxInputCurrentPerMpptA: 13.5,
    note: "蓄電ハイブリッド(エビハチ)・単相9.9kW・5回路",
  },
  // === ダイヤゼブラ電機 三相9.9kW（自家消費・FIT/FIP対応・JET認証） ===
  {
    id: "dz_epl_t99mp5",
    maker: "ダイヤゼブラ電機",
    model: "EPL-T99MP5（三相9.9kW）",
    kind: "new",
    ratedPowerKw: 9.9,
    mpptCount: 5,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 570,
    mpptVoltageMinV: 150,
    mpptVoltageMaxV: 550,
    startVoltageV: 150,
    maxInputCurrentPerMpptA: 10.3,
    note: "三相9.9kW・自家消費/FIT/FIP・JET認証。マスターボックス EOU-A-MBX06 必須。重塩害は EPL-T99MP5-SDR",
  },
];

/** 表示順：Huawei と OMRON KPV を上位に、その他は後。 */
function pcsPriority(p: PcsSpec): number {
  const maker = (p.maker ?? "").toLowerCase();
  if (maker.includes("huawei")) return 0;
  if ((p.model ?? "").toUpperCase().startsWith("KPV")) return 1;
  return 2;
}
function orderedPcs(list: PcsSpec[]): PcsSpec[] {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => pcsPriority(a.p) - pcsPriority(b.p) || a.i - b.i)
    .map((x) => x.p);
}

function loadDeletedSeedIds(): Set<string> {
  return new Set(load<string[]>(KEYS.deletedSeeds, []));
}

/** seed 由来のマスタが削除されたことを記録する（mergeSeed による復活を防ぐ）。 */
function markSeedDeleted(id: string): void {
  const s = loadDeletedSeedIds();
  if (s.has(id)) return;
  s.add(id);
  save(KEYS.deletedSeeds, [...s]);
}

/** 保存済みリストに、未登録の初期搭載マスタ（seed）を補完する。ユーザーが削除した seed は復活させない。 */
function mergeSeed<T extends { id: string }>(stored: T[], seed: T[]): T[] {
  const ids = new Set(stored.map((s) => s.id));
  const deleted = loadDeletedSeedIds();
  const missing = seed.filter((s) => !ids.has(s.id) && !deleted.has(s.id));
  return missing.length ? [...stored, ...missing] : stored;
}

export function usePanels() {
  const [panels, setPanels] = useState<PanelSpec[]>(() =>
    mergeSeed(load(KEYS.panels, SEED_PANELS), SEED_PANELS)
  );
  useEffect(() => save(KEYS.panels, panels), [panels]);

  const upsert = useCallback((p: PanelSpec) => {
    setPanels((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i === -1) return [...prev, p];
      const next = prev.slice();
      next[i] = p;
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    markSeedDeleted(id); // seed 以外の id でも記録して害はない
    setPanels((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return { panels, upsert, remove };
}

export function usePcsList() {
  const [pcsList, setPcsList] = useState<PcsSpec[]>(() =>
    mergeSeed(load(KEYS.pcs, SEED_PCS), SEED_PCS)
  );
  useEffect(() => save(KEYS.pcs, pcsList), [pcsList]);

  const upsert = useCallback((p: PcsSpec) => {
    setPcsList((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i === -1) return [...prev, p];
      const next = prev.slice();
      next[i] = p;
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    markSeedDeleted(id); // seed 以外の id でも記録して害はない
    setPcsList((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // 表示は Huawei・KPV を上位に並べ替えて返す
  return { pcsList: orderedPcs(pcsList), upsert, remove };
}

export function useConditions() {
  const [conditions, setConditions] = useState<DesignConditions>(() =>
    load(KEYS.conditions, DEFAULT_CONDITIONS)
  );
  useEffect(() => save(KEYS.conditions, conditions), [conditions]);
  return { conditions, setConditions };
}

export function useCostRates() {
  const [costRates, setCostRates] = useState<CostRates>(() =>
    load(KEYS.costRates, DEFAULT_COST_RATES)
  );
  useEffect(() => save(KEYS.costRates, costRates), [costRates]);
  return { costRates, setCostRates };
}

function newPlant(name: string, layout?: LayoutProject): PowerPlant {
  return {
    id: uid("plant"),
    name,
    address: "",
    note: "",
    outputCapKw: null,
    createdAt: Date.now(),
    layout: layout ?? { ...EMPTY_LAYOUT },
    wiring: { ...EMPTY_WIRING },
  };
}

/** 初期化：旧 単一レイアウト があれば 1 発電所へ移行。無ければ既定の発電所を作る。 */
function initialPlants(): PowerPlant[] {
  const saved = load<PowerPlant[] | null>(KEYS.plants, null);
  if (saved && saved.length) {
    // 発電所モデルへ移行済みなら、旧キーは背景写真入りで容量を圧迫するだけなので捨てる
    try {
      localStorage.removeItem(KEYS.layout);
    } catch {
      /* ignore */
    }
    return saved;
  }
  const legacy = load<LayoutProject | null>(KEYS.layout, null);
  // 背景写真なしで配列だけ置いた旧データも移行対象にする
  if (legacy && (legacy.imageDataUrl || (legacy.arrays?.length ?? 0) > 0)) {
    return [newPlant("発電所1", { ...EMPTY_LAYOUT, ...legacy })];
  }
  return [newPlant("発電所1")];
}

export function usePlants() {
  const [plants, setPlants] = useState<PowerPlant[]>(initialPlants);
  const [currentId, setCurrentIdState] = useState<string>(() => {
    const saved = load<string | null>(KEYS.currentPlant, null);
    return saved ?? "";
  });

  useEffect(() => save(KEYS.plants, plants), [plants]);
  useEffect(() => save(KEYS.currentPlant, currentId), [currentId]);

  // currentId が未設定/不正なら先頭に寄せる
  useEffect(() => {
    if (plants.length && !plants.some((p) => p.id === currentId)) {
      setCurrentIdState(plants[0].id);
    }
  }, [plants, currentId]);

  const current = plants.find((p) => p.id === currentId) ?? plants[0] ?? null;

  const setCurrentId = useCallback((id: string) => setCurrentIdState(id), []);

  const addPlant = useCallback((name: string) => {
    const p = newPlant(name || "新規発電所");
    setPlants((prev) => [...prev, p]);
    setCurrentIdState(p.id);
    return p.id;
  }, []);

  const updatePlant = useCallback(
    (id: string, patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>) => {
      setPlants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    []
  );

  const deletePlant = useCallback((id: string) => {
    setPlants((prev) => {
      const next = prev.filter((p) => p.id !== id);
      return next.length ? next : [newPlant("発電所1")];
    });
  }, []);

  /** 現在の発電所の図面を部分更新 */
  const patchLayout = useCallback(
    (p: Partial<LayoutProject>) => {
      setPlants((prev) =>
        prev.map((pl) =>
          pl.id === currentId ? { ...pl, layout: { ...pl.layout, ...p } } : pl
        )
      );
    },
    [currentId]
  );

  /** 現在の発電所の配線設定を部分更新 */
  const patchWiring = useCallback(
    (p: Partial<WiringPlan>) => {
      setPlants((prev) =>
        prev.map((pl) =>
          pl.id === currentId ? { ...pl, wiring: { ...pl.wiring, ...p } } : pl
        )
      );
    },
    [currentId]
  );

  // ===== 変更の検討の候補（プラン）管理 =====
  // アクティブ候補の内容は layout / pcsUnits（作業コピー）に展開して既存画面をそのまま使う。
  // 候補の保存は「切り替え時に作業コピーを書き戻す」方式。

  /** 作業コピー（現在編集中の変更内容）を候補のデータ形式で取り出す。 */
  const workingPlan = (pl: PowerPlant): Omit<PlanCandidate, "id" | "name"> => ({
    arrays: pl.layout.arrays,
    freePanels: pl.layout.freePanels,
    shadowZones: pl.layout.shadowZones,
    wiringOverrides: pl.layout.wiringOverrides,
    legend: pl.layout.legend,
    pcsUnits: pl.pcsUnits,
  });

  /** 作業コピーをアクティブ候補へ書き戻す。候補未使用なら何もしない。 */
  const saveWorkingToActive = (pl: PowerPlant): PowerPlant => {
    if (!pl.candidates?.length || !pl.currentCandidateId) return pl;
    return {
      ...pl,
      candidates: pl.candidates.map((c) =>
        c.id === pl.currentCandidateId ? { ...c, ...workingPlan(pl) } : c
      ),
    };
  };

  /** 候補が無い発電所に、現在の内容を「候補1」として作る。 */
  const ensureCandidates = (pl: PowerPlant): PowerPlant => {
    if (pl.candidates?.length) return pl;
    const first: PlanCandidate = { id: uid("cand"), name: "候補1", ...workingPlan(pl) };
    return { ...pl, candidates: [first], currentCandidateId: first.id };
  };

  /** 候補のデータを作業コピーへ展開する。 */
  const loadCandidate = (pl: PowerPlant, c: PlanCandidate): PowerPlant => ({
    ...pl,
    layout: {
      ...pl.layout,
      arrays: c.arrays,
      freePanels: c.freePanels ?? [],
      shadowZones: c.shadowZones ?? [],
      wiringOverrides: c.wiringOverrides,
      legend: c.legend,
    },
    pcsUnits: c.pcsUnits,
    currentCandidateId: c.id,
  });

  /** 現在の内容のコピーで新しい候補を作り、それをアクティブにする。 */
  const addCandidate = useCallback(() => {
    setPlants((prev) =>
      prev.map((pl) => {
        if (pl.id !== currentId) return pl;
        const base = saveWorkingToActive(ensureCandidates(pl));
        const n = (base.candidates?.length ?? 0) + 1;
        const copy: PlanCandidate = {
          id: uid("cand"),
          name: `候補${n}`,
          // 流用/撤去マークや構成を引き継いだコピーから検討を始める
          ...(JSON.parse(JSON.stringify(workingPlan(base))) as Omit<PlanCandidate, "id" | "name">),
        };
        return { ...base, candidates: [...(base.candidates ?? []), copy], currentCandidateId: copy.id };
      })
    );
  }, [currentId]);

  /** 候補を切り替える（作業コピーを書き戻してから読込）。 */
  const switchCandidate = useCallback(
    (candId: string) => {
      setPlants((prev) =>
        prev.map((pl) => {
          if (pl.id !== currentId) return pl;
          const saved = saveWorkingToActive(ensureCandidates(pl));
          const c = saved.candidates?.find((x) => x.id === candId);
          return c ? loadCandidate(saved, c) : saved;
        })
      );
    },
    [currentId]
  );

  const renameCandidate = useCallback(
    (candId: string, name: string) => {
      setPlants((prev) =>
        prev.map((pl) =>
          pl.id === currentId
            ? {
                ...pl,
                candidates: (pl.candidates ?? []).map((c) =>
                  c.id === candId ? { ...c, name } : c
                ),
              }
            : pl
        )
      );
    },
    [currentId]
  );

  /** 候補を削除する。アクティブ候補を消した場合は残りの先頭を読み込む。最後の1つは消せない。 */
  const deleteCandidate = useCallback(
    (candId: string) => {
      setPlants((prev) =>
        prev.map((pl) => {
          if (pl.id !== currentId) return pl;
          const list = pl.candidates ?? [];
          if (list.length <= 1) return pl;
          const rest = list.filter((c) => c.id !== candId);
          let next: PowerPlant = { ...pl, candidates: rest };
          if (pl.currentCandidateId === candId) next = loadCandidate(next, rest[0]);
          return next;
        })
      );
    },
    [currentId]
  );

  return {
    plants,
    current,
    currentId: current?.id ?? "",
    setCurrentId,
    addPlant,
    updatePlant,
    deletePlant,
    patchLayout,
    patchWiring,
    addCandidate,
    switchCandidate,
    renameCandidate,
    deleteCandidate,
  };
}
