# パワコン台ごとの新設/既設(kind)指定 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パワコン構成の各台に「新設/既設」を持たせ（`PcsUnitLine.kind`）、概算コストの「反映」が台ごとの実効種別で新設/既設を判定するようにする（反映で既設が新設に戻るバグを根本修正）。

**Architecture:** 型に任意フィールド `kind` を追加し、`PcsComposer` に台ごとの種別セレクトを足す。`CostEstimator` の `derived.newPcs` を実効種別（`unit.kind ?? master.kind`）で集計する。React 単体テスト基盤が無いため検証は稼働アプリで手動確認。

**Tech Stack:** React + Vite + TypeScript。仕様: `docs/superpowers/specs/2026-06-16-pcs-unit-kind-design.md`。

## ファイル構成
- 変更 `src/types.ts`：`PcsUnitLine` に `kind?: "existing" | "new"`。
- 変更 `src/components/PcsComposer.tsx`：各台カードに「種別」セレクト。
- 変更 `src/components/CostEstimator.tsx`：`derived.newPcs` を実効種別で集計。

---

## Task 1: PcsUnitLine に kind を追加

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 型にフィールド追加**

`src/types.ts` の `PcsUnitLine` インターフェースに `kind` を追加する。`strings?: PcsString[];` の行の直後（インターフェースの末尾フィールド付近）に挿入:

```ts
  /** 1台あたりのストリング構成（任意）。未指定なら台数×ACのみ集計。 */
  strings?: PcsString[];
  /** この台の新設/既設の上書き。未指定なら機種マスタの kind を継承。 */
  kind?: "existing" | "new";
```

（既存の `strings?` 行はそのまま残し、その下に `kind?` を足すだけ。コメントの重複に注意し、`strings?` の既存コメントは変更しない。）

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし（フィールド追加のみ）

- [ ] **Step 3: コミット**

```bash
git add src/types.ts
git commit -m "feat(pcs): PcsUnitLine に台ごとの新設/既設 kind を追加"
```

---

## Task 2: パワコン構成に「種別」セレクトを追加

**Files:**
- Modify: `src/components/PcsComposer.tsx`

各台カードの「パワコン機種」field（`<div className="field" style={{ minWidth: 240 }}>…</div>`、MPPTヒントを含む）の**直後**、「メモ」field（`<div className="field" style={{ flex: 1, minWidth: 160 }}>`）の**直前**に「種別」セレクトを挿入する。

- [ ] **Step 1: 種別セレクトを挿入**

`src/components/PcsComposer.tsx` で、機種fieldを閉じる `</div>`（MPPTヒントの `<div className="hint">…</div>` の後の閉じ `</div>`、メモfieldの直前）と、メモfield開始 `<div className="field" style={{ flex: 1, minWidth: 160 }}>` の間に、次を挿入:

```tsx
            <div className="field" style={{ minWidth: 150 }}>
              <label>種別</label>
              <select
                value={g.line.kind ?? g.pcs?.kind ?? "new"}
                onChange={(e) => updateUnit(g.line.id, { kind: e.target.value as "existing" | "new" })}
              >
                <option value="new">新設</option>
                <option value="existing">既設（流用）</option>
              </select>
              <div className="hint">
                {(g.line.kind ?? g.pcs?.kind) === "existing" ? "流用＝設置費なし" : "新設＝設置費がかかる"}
              </div>
            </div>
```

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし（`updateUnit` は `Partial<PcsUnitLine>` を受けるため `kind` を渡せる。`g.pcs` は `PcsSpec | null` で `g.pcs?.kind` は `"existing" | "new" | undefined`）

- [ ] **Step 3: コミット**

```bash
git add src/components/PcsComposer.tsx
git commit -m "feat(pcs): パワコン構成の各台に新設/既設の種別セレクトを追加"
```

---

## Task 3: 概算コストの新設台数を実効種別で集計

**Files:**
- Modify: `src/components/CostEstimator.tsx`

- [ ] **Step 1: derived.newPcs を実効種別ベースに変更**

`src/components/CostEstimator.tsx` の新設パワコン台数集計（現状）:

```ts
    // 新設パワコン台数（マスタが新設のもの）
    let newPcs = 0;
    for (const u of plant.pcsUnits ?? []) {
      const pcs = pcsList.find((p) => p.id === u.pcsId);
      if (pcs?.kind === "new") newPcs += u.count ?? 1;
    }
```

を次に変更:

```ts
    // 新設パワコン台数（台ごとの実効種別＝ u.kind ?? マスタの kind が新設のもの）
    let newPcs = 0;
    for (const u of plant.pcsUnits ?? []) {
      const pcs = pcsList.find((p) => p.id === u.pcsId);
      const eff = u.kind ?? pcs?.kind;
      if (eff === "new") newPcs += u.count ?? 1;
    }
```

`applyFromLayout`（`setPcsMode(derived.newPcs > 0 ? "new" : "keep")`）は変更しない。全台を既設にすれば `derived.newPcs === 0` となり、反映後も既設のまま保たれる。

- [ ] **Step 2: 型チェック**

Run: `npx tsc --noEmit`
Expected: 型エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/components/CostEstimator.tsx
git commit -m "fix(cost): 反映の新設/既設判定を台ごとの実効種別にする"
```

---

## Task 4: 稼働アプリで手動確認

**Files:** （変更なし・検証のみ）

- [ ] **Step 1: 全体の型・テスト**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 既存62テスト全PASS・型エラーなし（本変更はロジック純関数に影響しない）

- [ ] **Step 2: 手動確認（コントローラが実施）**

dev サーバは新規起動しない（別で稼働中の可能性・ポート競合回避）。コントローラ側がブラウザで次を確認:
1. ③パワコン構成で、ある台の「種別」を**既設（流用）**に切替。ヒントが「流用＝設置費なし」に変わる。
2. ④概算コストで「🔄 現況レイアウトから反映」を押す。
3. パワコンが「既設流用」のまま（全台既設なら新設台数0）。**新設に戻らない**ことを確認。
4. 一部の台だけ既設にした場合、反映後の新設台数が**新設の台数ぶんだけ**になることを確認。

---

## セルフレビュー結果
- **Spec 3章（kind 追加）** → Task1。
- **Spec 4章（種別セレクト）** → Task2。`value = g.line.kind ?? g.pcs?.kind ?? "new"`、onChange で updateUnit。
- **Spec 5章（derived.newPcs 実効種別）** → Task3。`eff = u.kind ?? pcs?.kind`、`applyFromLayout` 不変。
- **Spec 6章（既定・後方互換）** → kind 未指定はマスタ継承。既存データ・自動構成・複製は不変。
- **Spec 7章（手動確認）** → Task4。
- プレースホルダなし。型整合（`"existing" | "new"`）を types/PcsComposer/CostEstimator で一貫使用。
