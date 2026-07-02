# Claude ワークログ — 直近の作業の流れ
> 別名(Slack): #ソーラーレイアウト 太陽光レイアウト&パワコン構成設計アプリ

> このファイルは「常時読む記憶」です。**小さく保ってください**。
> 古い記録は `/worklog` スキルが `archive/` に圧縮移動します。
> 新しいエントリは**この見出しの直下**（新しい順）に追記します。

---

## 2026-07-02 23:55 — DESKTOP-L9CSJDA — claude/pcs-optimizer-overload
- やったこと: **UX改善6フェーズ完了**（計7コミット f3c44b7〜6290233、全てPlaywright実機検証済み）。
  1. PDF差分コミット（工事説明書②配列番号バッジ＋凡例表＋背景減光＋パワコン色■）
  2. **②で既設の実体削除を禁止**（hoshiさん報告のデータ消失バグ。配列一覧は「全部撤去」に置換＋deleteArrayで二重ガード）
  3. **ビルド復旧**: コスト改修WIPを完成（layoutCompose.ts切り出し＋CandidateCostInputs新構造化＋candidateCost.ts正式追加）。tsc 16エラー→0、テスト80→99件
  4. **④コスト手入力を候補ごとに永続化**（切替・リロードで消えない。workingPlan/loadCandidateにactiveCost合流＋saveCostミラー保存。extraCostLines再計算バグも修正）
  5. **単価0円警告**: 単価未登録パワコンの黙殺を可視化（missingPcsPrices＋パワコン登録への誘導ボタン）
  6. 迷子防止（スケール未校正警告バナー→①校正モード誘導・EmptyState・numOrガード）
  7. **ダイアログ刷新**: alert/confirm/prompt 41箇所→ui/dialogs.tsx（Toast/Confirm/Prompt、依存追加なし）。store.ts保存失敗alertのみ意図的にnative維持。図面に**Redo（↪やり直す）**追加
- 決めたこと: 既設の実体削除は①フェーズ限定（②は可逆な撤去マークのみ）。コスト手入力は候補単位保存＋空欄=自動導出フォールバック。「反映」ボタンは保存値も消して自動追従へ復帰。
- 次の一手: OMRON等のseed単価はhoshiさんから実勢価格をもらってstore.tsのSEED_PCSに登録（それまでは0円警告が守る）。b.txt/e.txt/probe_defs.txt（デバッグ残骸）はhoshiさん確認後に削除。タッチ/タブレット対応は今回見送り（要望あれば別途）。

## 2026-06-28 19:00 — DESKTOP-L9CSJDA — main
- やったこと: パワコン構成の自動最適化を全面刷新（`src/calc/pcsOptimize.ts`＋`PcsComposer.tsx`）。目的＝各台の過積載率(DC/定格)を揃える＋全パネル使い切り。台数を型式のDC量に比例配分→型式内で直列均等(W差を直列長で吸収)→端数は直列+1で吸収→残れば⚠強制割当(マルチ機の空きMPPTのみ・電圧上限厳守)。非マルチ機は1MPPTでも±1直の並列混在可(例26枚=7直×2並+6直×2並)。検証は「並列合計≤上限」で判定。
- 追加: **おすすめ3案**(影に強い/標準/配線シンプル＝`pref` shade/balanced/wiring、`optimizeIntoUnitsPatterns`)、1案/2案/3案を横並び比較→選択適用。設計最低気温の既定を−3℃(西尾市基準・`DEFAULT_CONDITIONS`)＋StringCalculatorにヒント。
- 区分まわり: パワコンマスタの「区分(新設/既設)」を廃止(PcsRegistry/PcsSpec.kind任意化)、新設/既設は台ごと(PcsUnitLine.kind・既定=新設)。概算コストは**新設の台だけ・各台の実機種unitPriceYen**で計上(CostEstimator)。
- 決めたこと: 電圧上限は強制割当でも絶対に破らない(下限未満/本数は許容して警告)。電流は effParallel=min(stringsPerMppt,⌊MPPT最大電流÷Isc⌋) で分岐抑制(赤エラー防止)。
- 検証: vitest 80件通過。pcsOptimize/PcsComposer等の自分の変更は型エラー0。
- 次の一手: ⚠OMRON(KPV/KPR/KPW)はseed単価が未登録(0円)→「パワコン登録」で単価を入れる(or seedに追加)。`src/calc/candidateCost.ts`(未追跡)＋CostEstimator/CandidateCostInputsは別作業のコスト改修WIPで`npm run build`(tsc)が通らない→要整理。b.txt/e.txt/probe_defs.txtは不明な未追跡ファイル(掃除候補)。コード変更は未コミット(本記録はworklogのみ)。

## 2026-06-18 13:17 — DESKTOP-L9CSJDA — main
- 何のプロジェクト: 太陽光レイアウト&パワコン構成設計アプリ（React + Vite + TypeScript）。
- やったこと: 既存リポジトリ「solar-layout」を横断目次に取り込み、ワークログ一式を後付け。
- 注意（取り込み前からの未コミット変更）: `src/components/LayoutEditor.tsx` と `起動.bat` が変更済み（私は未着手・内容未確認）。
- 次の一手: 上記2ファイルの変更内容を確認し、意図した変更ならコミット、不要なら破棄を判断する。
