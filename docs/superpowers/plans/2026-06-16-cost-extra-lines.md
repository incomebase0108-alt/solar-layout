# 概算コスト「その他費用（任意行）」実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 概算コストに、名前＋数量＋単位＋単価の自由費目「その他費用」を追加する。発電所ごとに保存し、諸経費は行ごとにON/OFF。値引き（マイナス）対応。

**Architecture:** 計算は純関数 `estimateCost`（`src/calc/cost.ts`）に `otherLines` を足し、諸経費を「対象/対象外」で切り分ける（TDDでテスト）。型 `ExtraCostLine` を `types.ts` に追加し `PowerPlant.extraCostLines` に保存。UI（`CostEstimator.tsx`）に入力表を足し `updatePlant` で即保存。

**Tech Stack:** React + Vite + TypeScript、Vitest。仕様: `docs/superpowers/specs/2026-06-16-cost-extra-lines-design.md`。

## ファイル構成
- 変更 `src/types.ts`：`ExtraCostLine` 追加＋`PowerPlant.extraCostLines?`。
- 変更 `src/calc/cost.ts`：`CostInput.otherLines` 追加＋諸経費の切り分け。
- 変更 `src/calc/cost.test.ts`：その他費用のテスト追加。
- 変更 `src/components/CostEstimator.tsx`：その他費用の入力表＋estimateCostへ受け渡し。

---

## Task 1: 型を追加（types.ts）

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: ExtraCostLine と PowerPlant フィールドを追加**

`src/types.ts` の `PowerPlant` インターフェース定義の**直前**に `ExtraCostLine` を追加:

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

`PowerPlant` インターフェース内、`currentCandidateId?: string;` の直後（末尾フィールド付近）に追加:

```ts
  /** アクティブな候補の id */
  currentCandidateId?: string;
  /** 概算コストの「その他費用」行（任意・発電所ごとに保存） */
  extraCostLines?: ExtraCostLine[];
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/types.ts
git commit -m "feat(cost): その他費用 ExtraCostLine 型と PowerPlant.extraCostLines を追加"
```

---

## Task 2: estimateCost に otherLines を追加（TDD）

**Files:**
- Modify: `src/calc/cost.ts`
- Modify: `src/calc/cost.test.ts`

- [ ] **Step 1: 失敗するテストを追加**

`src/calc/cost.test.ts` の `describe("概算コスト", () => { … })` の中（既存 it の後ろ）に追加:

```ts
  it("その他費用 inMisc:true は諸経費対象（諸経費が増える）", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "足場", qty: 1, unit: "式", unitYen: 100000, inMisc: true }],
      rates,
    });
    // base: 材料2,000,000 + 設置800,000 = 2,800,000、+足場100,000 → 小計2,900,000
    expect(r.subtotalYen).toBe(2_900_000);
    expect(r.miscYen).toBe(290_000);   // 2,900,000 * 10%
    expect(r.totalYen).toBe(3_190_000);
  });

  it("その他費用 inMisc:false は諸経費対象外（小計・合計に入るが諸経費は増えない）", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "連系負担金", qty: 1, unit: "式", unitYen: 100000, inMisc: false }],
      rates,
    });
    expect(r.subtotalYen).toBe(2_900_000);
    expect(r.miscYen).toBe(280_000);   // base 2,800,000 * 10% のみ
    expect(r.totalYen).toBe(3_180_000); // 小計2,900,000 + 諸経費280,000
  });

  it("その他費用の値引き（単価マイナス）で小計・合計が減る", () => {
    const r = estimateCost({
      newPanelLines: [{ label: "A", count: 100, unitYen: 20000, w: 450 }],
      removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "値引き", qty: 1, unit: "式", unitYen: -300000, inMisc: false }],
      rates,
    });
    expect(r.subtotalYen).toBe(2_500_000); // 2,800,000 - 300,000
    expect(r.miscYen).toBe(280_000);       // base 2,800,000 * 10%
    expect(r.totalYen).toBe(2_780_000);
  });

  it("その他費用が見積内訳（lines）に表示行として並ぶ", () => {
    const r = estimateCost({
      newPanelLines: [], removedDisposal: 0, removedStock: 0, newPcsCount: 0, pcsUnitYen: 0, removedPcsCount: 0,
      otherLines: [{ label: "申請費", qty: 2, unit: "件", unitYen: 50000, inMisc: false }],
      rates,
    });
    const row = r.lines.find((l) => l.label === "申請費");
    expect(row).toBeTruthy();
    expect(row?.amountYen).toBe(100_000);
    expect(row?.unit).toBe("件");
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run src/calc/cost.test.ts`
Expected: FAIL／型エラー（`CostInput` に `otherLines` が無い・諸経費の切り分け未実装）

- [ ] **Step 3: cost.ts を実装**

(3-1) `CostInput` インターフェースに追加（`extraLines?` の直後）:

```ts
  /** 周辺機器など追加の材料費行（監視装置など）。任意。 */
  extraLines?: { label: string; count: number; unitYen: number }[];
  /** その他費用（任意）。inMisc=true は諸経費対象、false は対象外。 */
  otherLines?: { label: string; qty: number; unit: string; unitYen: number; inMisc: boolean }[];
```

(3-2) `estimateCost` 内、現在の `const lines: CostLine[] = [ … ].filter((l) => l.qty > 0);` から `return { … };` までを、次に置き換える。**既存の `lines` 配列の中身（新パネル〜監視装置の各行）はそのまま残し、変数名を `baseLines` に変える**だけで、後段を差し替える:

```ts
  const baseLines: CostLine[] = [
    // 新パネル材料費（型式ごと）
    ...newPanelLines.map((l) => ({
      label: `新パネル 材料費（${l.label}）`,
      qty: l.count,
      unit: "枚",
      unitYen: l.unitYen,
      amountYen: l.count * l.unitYen,
    })),
    {
      label: "パネル 設置工事",
      qty: newPanelsTotal,
      unit: "枚",
      unitYen: rates.panelInstallYen,
      amountYen: newPanelsTotal * rates.panelInstallYen,
    },
    {
      label: "既設パネル 撤去工事（処分＋在庫）",
      qty: removedTotal,
      unit: "枚",
      unitYen: rates.panelRemovalYen,
      amountYen: removedTotal * rates.panelRemovalYen,
    },
    {
      label: "既設パネル 処分費",
      qty: removedDisposal,
      unit: "枚",
      unitYen: rates.panelDisposalYen,
      amountYen: removedDisposal * rates.panelDisposalYen,
    },
    {
      label: "新パワコン 材料費",
      qty: newPcsCount,
      unit: "台",
      unitYen: pcsUnitYen,
      amountYen: newPcsCount * pcsUnitYen,
    },
    {
      label: "パワコン 設置工事",
      qty: newPcsCount,
      unit: "台",
      unitYen: rates.pcsInstallYen,
      amountYen: newPcsCount * rates.pcsInstallYen,
    },
    {
      label: "既設パワコン 撤去",
      qty: removedPcsCount,
      unit: "台",
      unitYen: rates.pcsRemovalYen,
      amountYen: removedPcsCount * rates.pcsRemovalYen,
    },
    // 周辺機器（監視装置など）
    ...(input.extraLines ?? []).map((e) => ({
      label: e.label,
      qty: e.count,
      unit: "式",
      unitYen: e.unitYen,
      amountYen: e.count * e.unitYen,
    })),
  ].filter((l) => l.qty > 0);

  // その他費用（任意）：表示行と諸経費対象分
  const otherDisplay: CostLine[] = (input.otherLines ?? [])
    .filter((l) => l.qty !== 0)
    .map((l) => ({ label: l.label, qty: l.qty, unit: l.unit, unitYen: l.unitYen, amountYen: l.qty * l.unitYen }));
  const otherMiscBaseYen = (input.otherLines ?? [])
    .filter((l) => l.qty !== 0 && l.inMisc)
    .reduce((s, l) => s + l.qty * l.unitYen, 0);

  const lines: CostLine[] = [...baseLines, ...otherDisplay];
  const subtotalYen = lines.reduce((s, l) => s + l.amountYen, 0);
  // 諸経費は「既存行 ＋ inMisc のその他費用」だけにかける
  const miscBaseYen = baseLines.reduce((s, l) => s + l.amountYen, 0) + otherMiscBaseYen;
  const miscYen = Math.round((miscBaseYen * rates.miscRatePct) / 100);
  const totalYen = subtotalYen + miscYen;
  const yenPerW = newPanelW > 0 ? totalYen / newPanelW : null;

  return { lines, subtotalYen, miscYen, totalYen, yenPerW };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run src/calc/cost.test.ts`
Expected: PASS（既存テスト＋追加4件）。既存の「材料費＋…」「在庫分は…」等が不変であること（後方互換）も確認。

- [ ] **Step 5: 全テスト＋型**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全PASS・型エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/calc/cost.ts src/calc/cost.test.ts
git commit -m "feat(cost): estimateCost にその他費用 otherLines と諸経費の切り分けを追加"
```

---

## Task 3: 概算コストにその他費用の入力表を追加（UI）

**Files:**
- Modify: `src/components/CostEstimator.tsx`

- [ ] **Step 1: import に型を追加**

`src/components/CostEstimator.tsx` の types import に `ExtraCostLine` を追加する。既存の types import 行（`import type { CostRates } from "../types";` 等、`CostRates` を含む import）に `ExtraCostLine` を足す。例：

```ts
import type { CostRates, ExtraCostLine } from "../types";
```

（既存 import の形に合わせて、同じ `from "../types"` の type import に `ExtraCostLine` を加える。`uid` は既存で import 済みのため追加不要。）

- [ ] **Step 2: ハンドラと estimateCost 受け渡しを追加**

`applyFromLayout` 関数の後ろ（`// ===== 集計 =====` の直前あたり）に、その他費用の取得・編集ヘルパを追加:

```ts
  // ===== その他費用（任意・発電所ごとに保存） =====
  const extraCostLines = plant.extraCostLines ?? [];
  const setExtra = (next: ExtraCostLine[]) => updatePlant(plant.id, { extraCostLines: next });
  const addExtra = () =>
    setExtra([...extraCostLines, { id: uid("ex"), label: "", qty: 1, unit: "式", unitYen: 0, inMisc: false }]);
  const updateExtra = (id: string, patch: Partial<ExtraCostLine>) =>
    setExtra(extraCostLines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeExtra = (id: string) => setExtra(extraCostLines.filter((l) => l.id !== id));
```

`estimateCost({ … })` の呼び出し（`useMemo` 内）に `otherLines` を追加（`rates: costRates,` の前後どこでも可）:

```ts
        extraLines,
        otherLines: extraCostLines.map((l) => ({
          label: l.label, qty: l.qty, unit: l.unit, unitYen: l.unitYen, inMisc: l.inMisc,
        })),
        rates: costRates,
```

その `useMemo` の依存配列に `plant.extraCostLines` を追加（再計算のため。配列末尾に足す）:

```ts
    [lines, removedDisposal, removedStock, pcsMode, newPcsCount, effPcsUnit, removedPcsCount, loggerType, loggerUnitYen, costRates, plant.extraCostLines]
```

- [ ] **Step 3: その他費用カードを描画**

監視装置カードを閉じる `</div>`（`<h2>監視装置（SmartLogger 等）</h2>` を含む card の終わり）の**直後**、「工事費・処分費・諸経費の単価設定」カードの**直前**に挿入:

```tsx
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>その他費用（任意）</h2>
          <span className="spacer" />
          <button className="btn secondary small no-print" onClick={addExtra}>＋ その他費用を追加</button>
        </div>
        <table className="list">
          <thead>
            <tr>
              <th>費目名</th><th className="num">数量</th><th>単位</th>
              <th className="num">単価(円)</th><th>諸経費</th><th className="num">金額</th><th></th>
            </tr>
          </thead>
          <tbody>
            {extraCostLines.map((l) => (
              <tr key={l.id}>
                <td>
                  <input type="text" placeholder="例) 連系負担金 / 申請費 / 値引き"
                    value={l.label} onChange={(e) => updateExtra(l.id, { label: e.target.value })} />
                </td>
                <td className="num">
                  <input type="number" style={{ width: 64 }} value={l.qty}
                    onChange={(e) => updateExtra(l.id, { qty: Number(e.target.value) || 0 })} />
                </td>
                <td>
                  <input type="text" style={{ width: 56 }} value={l.unit}
                    onChange={(e) => updateExtra(l.id, { unit: e.target.value })} />
                </td>
                <td className="num">
                  <input type="number" style={{ width: 110 }} value={l.unitYen}
                    onChange={(e) => updateExtra(l.id, { unitYen: Number(e.target.value) || 0 })} />
                </td>
                <td style={{ textAlign: "center" }}>
                  <input type="checkbox" checked={l.inMisc}
                    onChange={(e) => updateExtra(l.id, { inMisc: e.target.checked })} />
                </td>
                <td className="num" style={{ color: l.qty * l.unitYen < 0 ? "var(--danger)" : undefined }}>
                  {yen(l.qty * l.unitYen)}
                </td>
                <td className="num">
                  <button className="btn danger small" onClick={() => removeExtra(l.id)}>×</button>
                </td>
              </tr>
            ))}
            {extraCostLines.length === 0 && (
              <tr><td colSpan={7} className="empty">「＋ その他費用を追加」で連系負担金・申請費・値引き等を入れられます。</td></tr>
            )}
          </tbody>
        </table>
        <div className="hint">
          数量×単価で金額。値引きは単価にマイナスを入力。「諸経費」にチェックした行だけ諸経費率の対象になります。発電所ごとに保存されます。
        </div>
      </div>
```

- [ ] **Step 4: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし（`updatePlant` は `extraCostLines` を受けられる。`yen` は既存ヘルパ）

- [ ] **Step 5: コミット**

```bash
git add src/components/CostEstimator.tsx
git commit -m "feat(cost): 概算コストにその他費用（任意行）の入力表を追加"
```

---

## Task 4: 稼働アプリで手動確認

**Files:** （変更なし・検証のみ）

- [ ] **Step 1: 全体テスト＋型**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全PASS・型エラーなし

- [ ] **Step 2: 手動確認（コントローラが実施）**

dev サーバは新規起動しない（別で稼働中・ポート競合回避）。コントローラがブラウザで:
1. ④概算コストで「＋ その他費用を追加」→ 費目名・数量・単位・単価を入力。金額が数量×単価で出る。
2. 「諸経費」チェックON/OFFで諸経費・合計が変わる。
3. 値引き（単価マイナス）で小計・合計が減る（金額が赤系表示）。
4. 見積内訳（下の表）・印刷プレビューにその他費用が並ぶ。
5. リロードしても入力が残る（発電所ごと保存）。別発電所に切替→別管理になっている。

---

## セルフレビュー結果
- **Spec 3章（型）** → Task1。
- **Spec 4章（計算・諸経費切り分け）** → Task2。`miscBaseYen = baseLines + inMiscのその他費用`、`subtotal = 全行`、`total = subtotal + misc`。後方互換（otherLines無し＝従来値）。
- **Spec 5章（UI）** → Task3。表・追加/削除・即 updatePlant 保存・estimateCost へ otherLines・deps 追加。
- **Spec 6章（発電所ごと保存）** → `plant.extraCostLines`。
- **Spec 7章（テスト）** → Task2 で inMisc有/無・値引き・表示行の4テスト。既存テスト不変。
- プレースホルダなし。型整合（ExtraCostLine／otherLines の形）を types/cost/CostEstimator で一貫使用。`uid("ex")` は既存 uid を流用。
