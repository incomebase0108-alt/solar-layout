import { KEYS } from "../store";
import { putImage, getImage } from "./imageStore";

// ============================================================
// データの保存/読込（バックアップ・端末間移行）
//   全マスタ＋発電所を 1 つの JSON にまとめて入出力する。
//   背景画像は IndexedDB に分離保存しているため、バックアップ時は
//   IndexedDB から画像を集めて JSON に含め（完全復元できるように）、
//   読込時は画像を IndexedDB へ戻して localStorage には載せない。
// ============================================================

const FORMAT = "solar-layout-backup";
const VERSION = 1;

/** バックアップ促し用の時刻キー（KEYS とは別＝バックアップ対象に含めない）。 */
export const BACKUP_META = {
  lastBackupAt: "solar-layout.lastBackupAt",
  lastChangeAt: "solar-layout.lastChangeAt",
} as const;

/** データに変更があったことを記録する（バックアップ促しの判定に使う）。 */
export function recordDataChange(): void {
  try {
    localStorage.setItem(BACKUP_META.lastChangeAt, String(Date.now()));
  } catch {
    /* 容量超過等は無視（促し判定が出ないだけ） */
  }
}

/** バックアップを取った時刻を記録する。 */
export function recordBackupDone(): void {
  try {
    localStorage.setItem(BACKUP_META.lastBackupAt, String(Date.now()));
  } catch {
    /* ignore */
  }
}

const DAY_MS = 86_400_000;

/**
 * バックアップを促すべきか。
 *   最終バックアップ以降に編集があり、かつ「未バックアップ」または「7日以上経過」のとき true。
 */
export function shouldRemindBackup(): boolean {
  const change = Number(localStorage.getItem(BACKUP_META.lastChangeAt) || 0);
  const backup = Number(localStorage.getItem(BACKUP_META.lastBackupAt) || 0);
  const hasUnsaved = change > backup; // 保存後に編集あり（未バックアップなら backup=0）
  if (!hasUnsaved) return false;
  if (backup === 0) return true; // 一度もバックアップしていない
  return Date.now() - backup >= 7 * DAY_MS;
}

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  data: Record<string, unknown>;
}

type PlantLike = { id?: string; layout?: { imageDataUrl?: string | null } };

/** localStorage の全データを集め、画像を IndexedDB から復元して完全なバックアップ内容を作る。 */
export async function buildBackupPayload(): Promise<BackupFile> {
  const data: Record<string, unknown> = {};
  for (const key of Object.values(KEYS)) {
    const raw = localStorage.getItem(key);
    if (raw != null) {
      try {
        data[key] = JSON.parse(raw);
      } catch {
        /* 壊れた値はスキップ */
      }
    }
  }
  // plants の画像は IndexedDB 側にあるので、JSON へ埋め戻す（バックアップ単体で復元可能に）
  const plants = data[KEYS.plants];
  if (Array.isArray(plants)) {
    for (const p of plants as PlantLike[]) {
      if (p && p.id && p.layout && !p.layout.imageDataUrl) {
        const url = await getImage(p.id).catch(() => null);
        if (url) p.layout.imageDataUrl = url;
      }
    }
  }
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), data };
}

/** 現在のデータ全体を JSON ファイルとしてダウンロードする。 */
export async function exportAll(): Promise<void> {
  const payload = await buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `solar-layout_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  recordBackupDone();
}

/** キーごとの期待する型。壊れたバックアップを取り込むと起動不能（白画面）になるため検証する。 */
function isValidValue(key: string, value: unknown): boolean {
  switch (key) {
    case KEYS.panels:
    case KEYS.pcs:
    case KEYS.plants:
    case KEYS.deletedSeeds:
      return Array.isArray(value);
    case KEYS.conditions:
    case KEYS.layout:
    case KEYS.costRates:
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case KEYS.currentPlant:
      return typeof value === "string";
    default:
      return false;
  }
}

/**
 * バックアップの data を localStorage / IndexedDB へ反映する。
 * 画像は IndexedDB へ書き、localStorage の plants からは外す（容量対策・新モデルと整合）。
 * 全キーを検証してから書き込む（途中で失敗して中途半端な状態にならないように）。
 */
export async function applyBackupData(rawData: Record<string, unknown>): Promise<void> {
  const known = new Set<string>(Object.values(KEYS));
  const entries = Object.entries(rawData).filter(([key]) => known.has(key));
  const bad = entries.filter(([key, value]) => !isValidValue(key, value));
  if (bad.length) {
    throw new Error(`バックアップの内容が壊れています（${bad.map(([k]) => k).join(", ")}）。読込を中止しました。`);
  }
  for (const [key, value] of entries) {
    if (key === KEYS.plants && Array.isArray(value)) {
      for (const p of value as PlantLike[]) {
        const url = p?.layout?.imageDataUrl;
        if (url && p.id) {
          try {
            await putImage(p.id, url);
            p.layout!.imageDataUrl = null; // localStorage には載せない
          } catch {
            /* IndexedDB不可：画像は localStorage に残す（従来動作） */
          }
        }
      }
    }
    localStorage.setItem(key, JSON.stringify(value));
  }
}

/**
 * バックアップ JSON を読み込み、localStorage / IndexedDB へ反映する。
 * 反映後はリロードして全画面に適用するのが安全。
 */
export async function importAll(file: File): Promise<void> {
  let parsed: BackupFile;
  try {
    parsed = JSON.parse(await file.text()) as BackupFile;
  } catch {
    throw new Error("ファイルの読込に失敗しました。");
  }
  if (parsed.format !== FORMAT || typeof parsed.data !== "object" || parsed.data === null) {
    throw new Error("対応していないファイル形式です。");
  }
  await applyBackupData(parsed.data as Record<string, unknown>);
}
