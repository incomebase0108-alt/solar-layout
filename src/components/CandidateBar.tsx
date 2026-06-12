import type { PowerPlant } from "../types";

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
 * 追加した時点で現在の内容が候補1として保存され、そのコピー＝候補2から検討が始まる。
 */
export function CandidateBar({ plant, switchCandidate, addCandidate, renameCandidate, deleteCandidate }: Props) {
  const candidates = plant.candidates ?? [];
  const activeId = plant.currentCandidateId;

  function rename(id: string, current: string) {
    const name = prompt("候補の名前", current);
    if (name && name.trim()) renameCandidate(id, name.trim());
  }

  function remove(id: string, name: string) {
    if (confirm(`${name} を削除しますか？（この候補の変更内容・パワコン構成が消えます）`)) {
      deleteCandidate(id);
    }
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
                {candidates.length > 1 && (
                  <button className="cand-icon" title="この候補を削除" onClick={() => remove(c.id, c.name)}>×</button>
                )}
              </>
            )}
          </span>
        ))
      )}
      <button className="btn secondary small" onClick={addCandidate} title="現在の内容をコピーして新しい候補を作る">
        ＋ 候補を追加
      </button>
      <span className="hint" style={{ marginTop: 0 }}>
        候補ごとに 流用/撤去・新設・パワコン構成・概算コスト を分けて比較できます（既設図面・基準は共通）。
      </span>
    </div>
  );
}
