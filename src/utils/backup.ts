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
        if (parsed.format !== FORMAT || typeof parsed.data !== "object") {
          throw new Error("対応していないファイル形式です。");
        }
        const known = new Set<string>(Object.values(KEYS));
        for (const [key, value] of Object.entries(parsed.data)) {
          if (known.has(key)) {
            localStorage.setItem(key, JSON.stringify(value));
          }
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
