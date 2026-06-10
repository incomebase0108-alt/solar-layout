interface Props {
  open: boolean;
  onClose: () => void;
  onDontShowAgain: () => void;
  /** タブに移動する（ガイドから直接ジャンプ用） */
  goTo: (tab: string) => void;
}

const STEPS: { tab: string; title: string; body: string }[] = [
  {
    tab: "panel",
    title: "① 使うパネルを確認・登録",
    body: "「パネル登録」タブ。主要メーカーは最初から入っています。無ければ寸法・電気特性を登録。",
  },
  {
    tab: "pcs",
    title: "② 使うパワコンを確認・登録",
    body: "「パワコン登録」タブ。Huawei・オムロン等は搭載済み。MPPT数・電圧/電流・マルチ有無を確認。",
  },
  {
    tab: "plant",
    title: "③ 発電所を追加",
    body: "「発電所」タブで新規追加。顧客名・所在地を入力（一覧から絞り込み検索できます）。",
  },
  {
    tab: "layout",
    title: "④ 現況レイアウトを作る",
    body: "住所→地図を取得（地理院・スケール自動）→「🔍スキャン」でパネル配置→流用/入換/撤去を指定。▣でパネルに最大ズーム。",
  },
  {
    tab: "pcsunits",
    title: "⑤ パワコン構成を組む",
    body: "台数を決めて1台ずつ設定。ストリング（直列/並列）を入れると合計AC/DC・過積載・電圧エラーを自動チェック。",
  },
  {
    tab: "layout",
    title: "⑥ 結線図を描く",
    body: "現況レイアウトで「🔌結線図を表示」。パワコン割付を色＋番号で自動描画、PDF印刷も可。",
  },
  {
    tab: "cost",
    title: "⑦ 概算コスト・費用対効果",
    body: "「概算コスト」で「🔄現況から反映」→新設/撤去/処分/在庫・監視装置を入れて見積・回収年数を算出。",
  },
];

/** 初めて使う人向けの使い方ガイド（初回自動表示＋ヘルプから再表示）。 */
export function Guide({ open, onClose, onDontShowAgain, goTo }: Props) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2,6,23,0.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "5vh 16px",
        overflow: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ maxWidth: 720, width: "100%", marginTop: 0 }}
      >
        <div className="row">
          <h2 style={{ margin: 0 }}>☀ はじめての方へ — 使い方ガイド</h2>
          <span className="spacer" />
          <button className="btn secondary small" onClick={onClose}>✕ 閉じる</button>
        </div>
        <p className="hint" style={{ marginTop: 6 }}>
          このアプリは<strong>ブラウザだけで動作</strong>し、データはお使いのPC内に保存されます（サーバー送信なし）。
          下の順に進めると、レイアウト→パワコン構成→結線図→概算コストが作れます。各ステップをクリックでそのタブへ移動します。
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {STEPS.map((s, i) => (
            <button
              key={i}
              className="card"
              onClick={() => { goTo(s.tab); onClose(); }}
              style={{ textAlign: "left", cursor: "pointer", margin: 0, padding: "10px 12px", border: "1px solid #1e293b" }}
            >
              <strong>{s.title}</strong>
              <div className="hint" style={{ marginTop: 2 }}>{s.body}</div>
            </button>
          ))}
        </div>

        <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
          <button className="btn" onClick={onClose}>始める</button>
          <span className="spacer" />
          <button className="btn secondary small" onClick={onDontShowAgain}>
            次回から自動表示しない
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          ※ いつでもヘッダーの「❓使い方」から開けます。
        </div>
      </div>
    </div>
  );
}
