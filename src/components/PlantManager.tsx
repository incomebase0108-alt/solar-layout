import { useState } from "react";
import type { PowerPlant } from "../types";
import { exportAll, importAll } from "../utils/backup";
import { useConfirm, useToast } from "./ui/dialogs";

interface Props {
  plants: PowerPlant[];
  currentId: string;
  setCurrentId: (id: string) => void;
  addPlant: (name: string) => string;
  updatePlant: (
    id: string,
    patch: Partial<Omit<PowerPlant, "id" | "layout" | "wiring">>
  ) => void;
  deletePlant: (id: string) => void;
}

function panelCount(p: PowerPlant): number {
  return p.layout.arrays.reduce((s, a) => s + a.rows * a.cols, 0);
}

export function PlantManager({
  plants,
  currentId,
  setCurrentId,
  addPlant,
  updatePlant,
  deletePlant,
}: Props) {
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const confirmDlg = useConfirm();
  const toast = useToast();
  const current = plants.find((p) => p.id === currentId);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? plants.filter((p) =>
        [p.name, p.customerName, p.address, p.note].some((v) => (v ?? "").toLowerCase().includes(q))
      )
    : plants;

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!(await confirmDlg({
      title: "バックアップの読込",
      message: "読込むと現在のデータ（マスタ・全発電所）が置き換わります。よろしいですか？",
      okLabel: "読込む",
      danger: true,
    }))) return;
    try {
      await importAll(file);
      // リロード前のトーストは見えないことがあるため、確実に伝わるようここは alert のまま
      alert("読込みました。画面を更新します。");
      window.location.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "読込に失敗しました。", "error");
    }
  }

  return (
    <>
      <div className="card">
        <h2>データの保存 / 読込</h2>
        <div className="row">
          <button className="btn secondary small" onClick={exportAll}>
            バックアップを保存（JSON）
          </button>
          <label className="btn secondary small" style={{ cursor: "pointer" }}>
            バックアップを読込
            <input type="file" accept="application/json,.json" onChange={onImport} style={{ display: "none" }} />
          </label>
          <span className="hint">
            マスタ＋全発電所を1ファイルに保存。端末間の移行・バックアップに。
          </span>
        </div>
      </div>

      <div className="card">
        <h2>発電所の登録</h2>
        <div className="row">
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>新しい発電所名</label>
            <input
              value={newName}
              placeholder="例：吉良町 荻原小川尻"
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <button
              className="btn"
              onClick={() => {
                addPlant(newName.trim() || "新規発電所");
                setNewName("");
              }}
            >
              発電所を追加
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <h2 style={{ margin: 0 }}>発電所一覧（{q ? `${filtered.length}/${plants.length}` : plants.length}）</h2>
          <span className="spacer" />
          <div className="field" style={{ minWidth: 240 }}>
            <label>絞り込み検索</label>
            <input
              type="search"
              value={query}
              placeholder="発電所名・顧客名・所在地で検索"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <table className="list" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>発電所名</th>
              <th>顧客名</th>
              <th>所在地</th>
              <th className="num">図面枚数</th>
              <th className="num">校正</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.id}
                style={{ outline: p.id === currentId ? "1px solid var(--accent)" : undefined }}
              >
                <td>
                  <strong>{p.name}</strong>
                  {p.id === currentId && (
                    <span className="badge new" style={{ marginLeft: 8 }}>選択中</span>
                  )}
                </td>
                <td>{p.customerName || <span className="hint">—</span>}</td>
                <td><span className="hint">{p.address || "未設定"}</span></td>
                <td className="num">{panelCount(p)} 枚</td>
                <td className="num">{p.layout.calibration ? "済" : "—"}</td>
                <td className="num">
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {p.id !== currentId && (
                      <button className="btn small" onClick={() => setCurrentId(p.id)}>選択</button>
                    )}
                    <button
                      className="btn danger small"
                      onClick={async () => {
                        if (await confirmDlg({
                          title: "発電所の削除",
                          message: `発電所「${p.name}」を削除しますか？図面も削除されます。`,
                          okLabel: "削除する",
                          danger: true,
                        })) deletePlant(p.id);
                      }}
                    >
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="empty">「{query}」に一致する発電所がありません。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {current && (
        <div className="card">
          <h2>選択中の発電所の情報</h2>
          <div className="form-grid">
            <div className="field">
              <label>発電所名</label>
              <input
                value={current.name}
                onChange={(e) => updatePlant(current.id, { name: e.target.value })}
              />
            </div>
            <div className="field">
              <label>顧客名</label>
              <input
                value={current.customerName ?? ""}
                placeholder="例：星野正好 様"
                onChange={(e) => updatePlant(current.id, { customerName: e.target.value })}
              />
            </div>
            <div className="field">
              <label>所在地</label>
              <input
                value={current.address ?? ""}
                onChange={(e) => updatePlant(current.id, { address: e.target.value })}
              />
            </div>
            <div className="field">
              <label>パネル出力上限 (kW)</label>
              <input
                type="number"
                step="0.1"
                placeholder="上限なし"
                value={current.outputCapKw ?? ""}
                onChange={(e) =>
                  updatePlant(current.id, {
                    outputCapKw: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
              <div className="hint">FIT買取価格区分の上限。最適化・配線でこれを超えると警告します。</div>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label>備考（連系容量・系統など）</label>
              <input
                value={current.note ?? ""}
                onChange={(e) => updatePlant(current.id, { note: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
