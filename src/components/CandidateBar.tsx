import type { PowerPlant } from "../types";
import { useConfirm, usePrompt } from "./ui/dialogs";

interface Props {
  plant: PowerPlant;
  switchCandidate: (id: string) => void;
  addCandidate: () => void;
  renameCandidate: (id: string, name: string) => void;
  deleteCandidate: (id: string) => void;
}

/**
 * 変更の検討の候補（プラン）切替バー。
 * 図面（②変更の検討）・パワコン構成・概算コストの3画面で共通に使う。
 * 候補未使用（candidates が空）の発電所では「＋候補を追加」だけを表示し、
 * 追加した時点で現在の内容が候補1として保存され、候補2はまっさら（既設のみ・全部流用）で始まる。
 * 以降の追加も常にまっさらから（候補同士は完全に独立）。
 */
export function CandidateBar({ plant, switchCandidate, addCandidate, renameCandidate, deleteCandidate }: Props) {
  const candidates = plant.candidates ?? [];
  const activeId = plant.currentCandidateId;
  const confirmDlg = useConfirm();
  const promptDlg = usePrompt();

  async function rename(id: string, current: string) {
    const name = await promptDlg({ title: "候補の名前を変更", message: "新しい名前を入力してください。", defaultValue: current });
    if (name && name.trim()) renameCandidate(id, name.trim());
  }

  async function remove(id: string, name: string) {
    const last = candidates.length <= 1;
    const msg = last
      ? `${name} を削除しますか？\n最後の候補なので候補未使用に戻り、図面は既設（全部流用）だけの状態になります。\n（この候補の変更内容・新設・パワコン構成は消えます）`
      : `${name} を削除しますか？（この候補の変更内容・パワコン構成が消えます）`;
    if (await confirmDlg({ title: "候補の削除", message: msg, okLabel: "削除する", danger: true })) {
      deleteCandidate(id);
    }
  }

  /** 候補の追加。最初の候補を作る前に、既設変更との関係を一言知らせておく。 */
  async function add() {
    if (
      candidates.length === 0 &&
      !(await confirmDlg({
        title: "変更の検討を始めます",
        message:
          "注意：候補を作った後で「① 既設の設定」（地図・写真・校正・向き）を変更すると、全ての候補が削除されます。\n" +
          "既設の図面を直す予定があれば、先に済ませてから候補を作ってください。\n\nよろしいですか？",
        okLabel: "始める",
      }))
    )
      return;
    addCandidate();
  }

  return (
    <div className="candidate-bar no-print">
      <span className="hint" style={{ marginTop: 0 }}>検討候補:</span>
      {candidates.length === 0 ? (
        <span className="hint" style={{ marginTop: 0 }}>（現在の内容のみ）</span>
      ) : (
        candidates.map((c) => (
          <span key={c.id} className={"cand-pill" + (c.id === activeId ? " active" : "")}>
            <button className="cand-name" onClick={() => c.id !== activeId && switchCandidate(c.id)}>
              {c.name}
            </button>
            {c.id === activeId && (
              <>
                <button className="cand-icon" title="名前を変更" onClick={() => rename(c.id, c.name)}>✎</button>
                <button className="cand-icon" title="この候補を削除" onClick={() => remove(c.id, c.name)}>×</button>
              </>
            )}
          </span>
        ))
      )}
      <button className="btn secondary small" onClick={add} title="まっさら（既設のみ・全部流用）の新しい候補を作る">
        ＋ 候補を追加
      </button>
      <span className="hint" style={{ marginTop: 0 }}>
        候補ごとに 流用/撤去・新設・パワコン構成・概算コスト を分けて比較できます（既設図面・基準は共通）。
      </span>
    </div>
  );
}
