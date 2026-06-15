import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { putImage, getImage, deleteImage, listImageIds } from "./imageStore";

// 各テスト前にIndexedDBの中身を空にする（前テストの残りを持ち越さない）
async function clearAll() {
  for (const id of await listImageIds()) await deleteImage(id);
}

describe("imageStore（IndexedDBの画像保管）", () => {
  beforeEach(clearAll);

  it("保存した画像を取り出せる", async () => {
    await putImage("plant_a", "data:image/png;base64,AAAA");
    expect(await getImage("plant_a")).toBe("data:image/png;base64,AAAA");
  });

  it("無いIDはnullを返す", async () => {
    expect(await getImage("missing")).toBeNull();
  });

  it("同じIDへの保存は上書きする", async () => {
    await putImage("plant_a", "data:image/png;base64,OLD");
    await putImage("plant_a", "data:image/png;base64,NEW");
    expect(await getImage("plant_a")).toBe("data:image/png;base64,NEW");
  });

  it("削除すると取り出せなくなる", async () => {
    await putImage("plant_a", "data:image/png;base64,AAAA");
    await deleteImage("plant_a");
    expect(await getImage("plant_a")).toBeNull();
  });

  it("保存済みのID一覧を返す", async () => {
    await putImage("plant_a", "x");
    await putImage("plant_b", "y");
    const ids = await listImageIds();
    expect(ids.sort()).toEqual(["plant_a", "plant_b"]);
  });
});
