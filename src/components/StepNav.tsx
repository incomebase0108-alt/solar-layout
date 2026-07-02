import type { PowerPlant } from "../types";

interface Props {
  tab: string;
  setTab: (t: string) => void;
  current: PowerPlant | null;
}

/** 作業フロー順のメインタブ（①→④の順に進めば完成する） */
const FLOW = [
  { key: "plant", num: "①", label: "発電所" },
  { key: "layout", num: "②", label: "図面" },
  { key: "pcsunits", num: "③", label: "パワコン構成" },
  { key: "cost", num: "④", label: "概算コスト" },
];

/** 使用頻度の低いマスタ・ツール類（右側に小さくまとめる） */
const MASTER = [
  { key: "panel", label: "パネル登録" },
  { key: "pcs", label: "パワコン登録" },
  { key: "string", label: "ストリング計算" },
];

/** データの入力状況から「次にやること」を判定する。 */
export function nextStep(current: PowerPlant | null): { tab: string; text: string } | null {
  if (!current) {
    return { tab: "plant", text: "発電所を追加しましょう（顧客名・所在地を入力）" };
  }
  if (!current.layout.imageDataUrl) {
    return { tab: "layout", text: "②図面で住所から航空写真を取得しましょう（写真アップロードでも可）" };
  }
  if ((current.layout.arrays?.length ?? 0) === 0) {
    return { tab: "layout", text: "②図面の「🔍スキャン」でパネル配置を読み取りましょう（範囲をドラッグで行×列を自動検出）" };
  }
  if (!current.pcsUnits || current.pcsUnits.length === 0) {
    return { tab: "pcsunits", text: "③パワコン構成を組みましょう（機種と台数を選ぶと電圧・過積載を自動チェック）" };
  }
  return { tab: "cost", text: "④概算コストで見積・回収年数を確認できます（図面・結線図・工事説明書のPDF出力も可）" };
}

/**
 * 発電所が未選択（データ破損等）のとき、②〜④タブが真っ白にならないための空状態表示。
 * 通常は発電所が自動で用意されるため出番は少ないが、迷子防止の安全網として置く。
 */
export function EmptyState({ goPlant }: { goPlant: () => void }) {
  return (
    <div className="card" style={{ textAlign: "center", padding: 32 }}>
      <div style={{ fontSize: 28 }}>☀</div>
      <p>対象の発電所が選ばれていません。まず「①発電所」で発電所を追加・選択してください。</p>
      <button className="btn" onClick={goPlant}>① 発電所タブへ →</button>
    </div>
  );
}

/**
 * 作業フロー順タブ＋マスタ群＋「次にやること」案内バナー。
 * バナーは案内先のタブを開いている間は消える（邪魔にならないように）。
 */
export function StepNav({ tab, setTab, current }: Props) {
  const hint = nextStep(current);
  return (
    <>
      <nav className="tabs stepnav no-print">
        {FLOW.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            <span className="step-num">{t.num}</span>
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <span className="stepnav-label">⚙ マスタ:</span>
        {MASTER.map((t) => (
          <button
            key={t.key}
            className={"master-tab" + (tab === t.key ? " active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {hint && tab !== hint.tab && (
        <div className="next-hint no-print">
          <span className="next-hint-text">💡 次にやること: {hint.text}</span>
          <button className="btn small" onClick={() => setTab(hint.tab)}>ここから →</button>
        </div>
      )}
    </>
  );
}
