// ============================================================
// 背景写真の保管（IndexedDB）
//   localStorage は容量が小さく（約5〜10MB）、base64 画像を入れると
//   発電所が増えるほど上限に当たる。画像だけ容量の大きい IndexedDB に逃がす。
//   キーは発電所ID（1発電所＝1枚）。値は dataURL 文字列。
// ============================================================

const DB_NAME = "solar-layout-images";
const STORE = "images";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けませんでした"));
  });
  return dbPromise;
}

/** 1トランザクションを Promise で待つ薄いヘルパ。 */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => resolve(req.result);
        t.onerror = () => reject(t.error ?? new Error("IndexedDB 操作に失敗しました"));
        t.onabort = () => reject(t.error ?? new Error("IndexedDB 操作が中断されました"));
      })
  );
}

/** 画像（dataURL）を発電所ID単位で保存する（同IDは上書き）。 */
export function putImage(id: string, dataUrl: string): Promise<void> {
  return tx("readwrite", (s) => s.put({ id, dataUrl })).then(() => undefined);
}

/** 画像（dataURL）を取り出す。無ければ null。 */
export function getImage(id: string): Promise<string | null> {
  return tx<{ id: string; dataUrl: string } | undefined>("readonly", (s) => s.get(id)).then(
    (row) => row?.dataUrl ?? null
  );
}

/** 画像を削除する。 */
export function deleteImage(id: string): Promise<void> {
  return tx("readwrite", (s) => s.delete(id)).then(() => undefined);
}

/** 保存済みの発電所ID一覧（バックアップ収集・不要画像の掃除に使う）。 */
export function listImageIds(): Promise<string[]> {
  return tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((keys) => keys.map(String));
}
