# 概算コスト：その他費用（任意行）設計

- 日付: 2026-06-16
- 対象: ソーラーレイアウト設計支援アプリ（`solar-layout`）／④概算コスト
- 種別: 機能追加

## 1. 背景・目的

現状の概算コストは固定項目（新パネル材料費・設置/撤去工事・処分費・パワコン材料/設置/撤去・
監視装置・諸経費）でしか組めず、**任意の費目を自由に足す欄がない**。
連系負担金・申請手数料・運搬費・足場・部材・値引き・雑費などを見積に入れたいので、
**自由入力の「その他費用」行**を追加する。

## 2. 決定方針（合意済み）

- 1行の入力項目は **名前＋数量＋単位＋単価**（金額＝数量×単価）。単価マイナス可（値引き）。
- 入力したその他費用は **発電所ごとに保存**（`plant.extraCostLines`）。リロード後も残る。
- 諸経費（諸経費率%）は **行ごとに対象ON/OFF** を選べる。
- 既存データ（未定義）は空配列扱い＝挙動不変。

## 3. データモデル（types.ts）

```ts
/** 概算コストの任意の追加費目（その他費用）。発電所ごとに保存する。 */
export interface ExtraCostLine {
  id: string;
  /** 費目名（例: 連系負担金 / 申請費 / 値引き） */
  label: string;
  /** 数量 */
  qty: number;
  /** 単位（式 / 台 / m / 枚 など自由入力） */
  unit: string;
  /** 単価（円・マイナス可＝値引き） */
  unitYen: number;
  /** 諸経費(率%)の対象にするか */
  inMisc: boolean;
}
```

`PowerPlant` に追加：

```ts
  /** 概算コストの「その他費用」行（任意・発電所ごとに保存） */
  extraCostLines?: ExtraCostLine[];
```

## 4. 計算（cost.ts の estimateCost）

`CostInput` に `otherLines` を追加：

```ts
  /** その他費用（任意）。inMisc=true は諸経費対象、false は対象外。 */
  otherLines?: { label: string; qty: number; unit: string; unitYen: number; inMisc: boolean }[];
```

集計ロジック：
- その他費用の各行 `amount = qty * unitYen`（マイナス可）。表示行に含める（`qty !== 0` の行のみ）。
- **小計（subtotalYen）** = 既存の全行（監視装置含む）＋ その他費用すべての amount 合計。
- **諸経費の対象小計** = 既存の全行 ＋ その他費用のうち `inMisc:true` の amount 合計
  （＝ subtotal − `inMisc:false` のその他費用合計）。
- **諸経費（miscYen）** = round(諸経費対象小計 × `rates.miscRatePct` / 100)。
- **合計（totalYen）** = subtotalYen + miscYen。
- **円/W（yenPerW）** = 新設W>0 のとき totalYen / 新設W（従来どおり。その他費用も合計に反映）。

`CostResult.lines` には、その他費用の各行も `{ label, qty, unit: 入力の単位, unitYen, amountYen }` として
追加し、見積内訳（表示・印刷/PDF）に並べる。既存行と同じ `filter`（金額が出る行）で扱う。

`CostLine` の構造は既存のまま流用（label/qty/unit/unitYen/amountYen）。

## 5. UI（CostEstimator.tsx）

「その他費用（任意）」セクションを新設（パワコン／監視装置の近く、見積内訳の前）。表形式：

| 費目名 | 数量 | 単位 | 単価(円) | 諸経費 | 金額 | × |
|---|---|---|---|---|---|---|

- 「＋ その他費用を追加」ボタンで空行を追加。× で行削除。
- 各セルは入力欄（費目名=text、数量=number、単位=text、単価=number、諸経費=checkbox）。
- 金額列は `qty * unitYen` を自動表示（マイナスは赤系で表示・任意）。
- 編集は即 `updatePlant(plant.id, { extraCostLines: next })` で保存（既存の `setPlantNum` と同様に plant へ書く）。
- `estimateCost` 呼び出しに `otherLines: (plant.extraCostLines ?? []).map(...)` を渡す（`inMisc` を含める）。
- `result` の依存配列に `plant.extraCostLines` を加える（再計算されるように）。

## 6. 保存の単位

`plant.extraCostLines`（発電所直下）に保存。候補（検討プラン）を切り替えても共通で残る
（ご要望「発電所ごとに管理」に合わせる）。`updatePlant` は `Partial<Omit<PowerPlant,"id"|"layout"|"wiring">>`
を受けるため `extraCostLines` を渡せる。

## 7. テスト（cost.test.ts）

`estimateCost` は純関数なので単体テストを追加：
- その他費用 `inMisc:true` が諸経費対象に入る（諸経費が増える）。
- その他費用 `inMisc:false` が諸経費対象外（小計・合計には入るが諸経費は増えない）。
- 値引き（`unitYen` マイナス）で小計・合計が減る。
- その他費用が `lines` に表示行として現れる。
- 既存のテスト（その他費用なし）は不変＝後方互換。

UI（React）は単体テスト基盤が無いため稼働アプリで手動確認（追加・編集・削除・保存・リロード後の残存・PDF表示）。

## 8. スコープ外（YAGNI）

- 候補（プラン）ごとに別のその他費用を持つこと（今回は発電所共通）。
- 費目テンプレート（よく使う費目の登録/呼び出し）。
- 概算コスト画面の他の編集欄（新設枚数・撤去等）の保存化（今回はその他費用のみ保存）。
