import { KEYS } from "../store";

// ============================================================
// データの保存/読込（バックアップ・端末間移行）
//   全マスタ＋発電所を 1 つの JSON にまとめて入出力する。
// ============================================================

const FORMAT = "solar-layout-backup";
const VERSION = 1;

interface BackupFile {
  format: string;
  version: number;
  exportedAt: string;
  data: Record<string, unknown>;
}

/** 現在のデータ全体を JSON ファイルとしてダウンロードする。 */
export function exportAll(): void {
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
  const payload: BackupFile = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `solar-layout_${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
 * バックアップ JSON を読み込み、localStorage へ反映する。
 * 反映後はリロードして全画面に適用するのが安全。
 */
export function importAll(file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as BackupFile;
        if (parsed.format !== FORMAT || typeof parsed.data !== "object" || parsed.data === null) {
          throw new Error("対応していないファイル形式です。");
        }
        const known = new Set<string>(Object.values(KEYS));
        // 全キーを検証してから書き込む（途中で失敗して中途半端な状態にならないように）
        const entries = Object.entries(parsed.data).filter(([key]) => known.has(key));
        const bad = entries.filter(([key, value]) => !isValidValue(key, value));
        if (bad.length) {
          throw new Error(`バックアップの内容が壊れています（${bad.map(([k]) => k).join(", ")}）。読込を中止しました。`);
        }
        for (const [key, value] of entries) {
          localStorage.setItem(key, JSON.stringify(value));
        }
        resolve();
      } catch (e) {
        reject(e instanceof Error ? e : new Error("読込に失敗しました。"));
      }
    };
    reader.onerror = () => reject(new Error("ファイルの読込に失敗しました。"));
    reader.readAsText(file);
  });
}
