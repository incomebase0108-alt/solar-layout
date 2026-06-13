// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { buildBackupPayload, applyBackupData, shouldRemindBackup, recordDataChange, recordBackupDone, BACKUP_META } from "./backup";
import { KEYS } from "../store";
import { putImage, getImage, listImageIds, deleteImage } from "./imageStore";

async function clearIdb() {
  for (const id of await listImageIds()) await deleteImage(id);
}

function samplePlant(id: string, imageDataUrl: string | null = null) {
  return {
    id,
    name: id,
    layout: { imageDataUrl, imageRotationDeg: 0, imageOpacity: 1, calibration: null, arrays: [], shadowZones: [], freePanels: [] },
    wiring: {},
  };
}

describe("バックアップの画像往復", () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearIdb();
  });

  it("export時：localStorageは画像なしでもIndexedDBの画像をJSONに含める", async () => {
    localStorage.setItem(KEYS.plants, JSON.stringify([samplePlant("p1", null)]));
    await putImage("p1", "data:image/png;base64,IMG1");
    const payload = await buildBackupPayload();
    const plants = payload.data[KEYS.plants] as Array<{ id: string; layout: { imageDataUrl: string | null } }>;
    expect(plants[0].layout.imageDataUrl).toBe("data:image/png;base64,IMG1");
  });

  it("import時：JSONの画像はIndexedDBへ入り、localStorageからは外れる", async () => {
    const data = { [KEYS.plants]: [samplePlant("p1", "data:image/png;base64,IMG1")] };
    await applyBackupData(data);
    // IndexedDBに入っている
    expect(await getImage("p1")).toBe("data:image/png;base64,IMG1");
    // localStorageのplantsには画像が載っていない（容量対策）
    const stored = JSON.parse(localStorage.getItem(KEYS.plants)!);
    expect(stored[0].layout.imageDataUrl).toBeNull();
  });

  it("export→importで画像が保持される（完全復元）", async () => {
    localStorage.setItem(KEYS.plants, JSON.stringify([samplePlant("p1", null)]));
    await putImage("p1", "data:image/png;base64,ROUNDTRIP");
    const payload = await buildBackupPayload();
    // 別環境を模してクリア
    localStorage.clear();
    await clearIdb();
    await applyBackupData(payload.data as Record<string, unknown>);
    expect(await getImage("p1")).toBe("data:image/png;base64,ROUNDTRIP");
  });
});

describe("バックアップ促しの判定", () => {
  beforeEach(() => localStorage.clear());

  it("データ未変更なら促さない", () => {
    expect(shouldRemindBackup()).toBe(false);
  });

  it("未バックアップで変更ありなら促す", () => {
    recordDataChange();
    expect(shouldRemindBackup()).toBe(true);
  });

  it("バックアップ直後（変更なし）は促さない", () => {
    recordDataChange();
    recordBackupDone();
    expect(shouldRemindBackup()).toBe(false);
  });

  it("バックアップ後7日未満の変更は促さない", () => {
    recordDataChange();
    recordBackupDone();
    // 3日前にバックアップ、その後に変更
    localStorage.setItem(BACKUP_META.lastBackupAt, String(Date.now() - 3 * 86400000));
    recordDataChange();
    expect(shouldRemindBackup()).toBe(false);
  });

  it("バックアップ後7日以上経過して変更ありなら促す", () => {
    localStorage.setItem(BACKUP_META.lastBackupAt, String(Date.now() - 8 * 86400000));
    recordDataChange();
    expect(shouldRemindBackup()).toBe(true);
  });
});
