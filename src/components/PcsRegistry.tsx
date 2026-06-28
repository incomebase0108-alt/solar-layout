import { useState } from "react";
import type { PcsSpec, PowerPlant } from "../types";
import { WARRANTY_OPTIONS } from "../types";
import { uid } from "../store";

interface Props {
  store: {
    pcsList: PcsSpec[];
    upsert: (p: PcsSpec) => void;
    remove: (id: string) => void;
  };
  /** 削除時の参照チェック用。使用中のパワコンを消すと kW・台数集計が黙って狂うため。 */
  plants: PowerPlant[];
}

function emptyPcs(): PcsSpec {
  return {
    id: uid("pcs"),
    maker: "",
    model: "",
    ratedPowerKw: 0,
    mpptCount: 1,
    multiMppt: true,
    stringsPerMppt: 1,
    maxInputVoltageV: 0,
    mpptVoltageMinV: 0,
    mpptVoltageMaxV: 0,
    startVoltageV: undefined,
    maxInputCurrentPerMpptA: 0,
    unitPriceYen: undefined,
    warranty: "",
    note: "",
  };
}

export function PcsRegistry({ store, plants }: Props) {
  const [draft, setDraft] = useState<PcsSpec>(emptyPcs());
  const [editing, setEditing] = useState(false);

  const num =
    (key: keyof PcsSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft((d) => ({ ...d, [key]: v === "" ? undefined : Number(v) }));
    };
  const str =
    (key: keyof PcsSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  function submit() {
    if (!draft.model.trim()) {
      alert("型番を入力してください");
      return;
    }
    // 空欄(undefined)のまま保存すると直列数計算が NaN になり、
    // 「最大入力電圧の超過」エラーが一切出なくなる（NaN比較は常にfalse）ため数値に補正する
    const fixed: PcsSpec = {
      ...draft,
      ratedPowerKw: Number(draft.ratedPowerKw) || 0,
      mpptCount: Math.max(1, Math.floor(Number(draft.mpptCount)) || 1),
      stringsPerMppt: Math.max(1, Math.floor(Number(draft.stringsPerMppt)) || 1),
      maxInputVoltageV: Number(draft.maxInputVoltageV) || 0,
      mpptVoltageMinV: Number(draft.mpptVoltageMinV) || 0,
      mpptVoltageMaxV: Number(draft.mpptVoltageMaxV) || 0,
      startVoltageV: draft.startVoltageV == null ? undefined : Number(draft.startVoltageV) || 0,
      maxInputCurrentPerMpptA: Number(draft.maxInputCurrentPerMpptA) || 0,
      unitPriceYen: draft.unitPriceYen == null ? undefined : Number(draft.unitPriceYen) || 0,
    };
    if (!fixed.maxInputVoltageV || !fixed.mpptVoltageMaxV) {
      if (
        !confirm(
          "最大入力電圧 / MPPT電圧上限が未入力（0）です。\n" +
            "このままだと直列数の電圧チェックが全ストリングに警告を出します。登録しますか？"
        )
      )
        return;
    }
    store.upsert(fixed);
    setDraft(emptyPcs());
    setEditing(false);
  }

  /** このパワコンを使っている発電所名（使用中の削除を止めるため）。 */
  function usedIn(id: string): string[] {
    return plants
      .filter(
        (pl) => (pl.pcsUnits ?? []).some((u) => u.pcsId === id) || pl.wiring?.pcsId === id
      )
      .map((pl) => pl.name);
  }

  function removePcs(p: PcsSpec) {
    const used = usedIn(p.id);
    if (used.length) {
      alert(
        `${p.model} は次の発電所で使用中のため削除できません：\n・${used.join("\n・")}\n\n先にパワコン構成から外してください。`
      );
      return;
    }
    if (confirm(`${p.model} を削除しますか？`)) store.remove(p.id);
  }

  function edit(p: PcsSpec) {
    setDraft({ ...p });
    setEditing(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** 既存パワコンを複製してフォームに展開（新規登録モード）。保証・単価だけ変えて登録すればバリエーションが作れる */
  function duplicate(p: PcsSpec) {
    setDraft({ ...p, id: uid("pcs") });
    setEditing(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <>
      <div className="card">
        <h2>{editing ? "パワコン編集" : "パワコン登録"}</h2>

        <h3>基本情報</h3>
        <div className="form-grid">
          <div className="field">
            <label>メーカー</label>
            <input value={draft.maker} onChange={str("maker")} />
          </div>
          <div className="field">
            <label>型番 *</label>
            <input value={draft.model} onChange={str("model")} />
          </div>
          <div className="field">
            <label>定格出力 (kW)</label>
            <input type="number" step="0.1" value={draft.ratedPowerKw || ""} onChange={num("ratedPowerKw")} />
          </div>
        </div>

        <h3>DC 入力仕様</h3>
        <div className="form-grid">
          <div className="field">
            <label>MPPT 回路数</label>
            <input type="number" value={draft.mpptCount || ""} onChange={num("mpptCount")} />
          </div>
          <div className="field">
            <label>マルチMPPT機能</label>
            <select
              value={draft.multiMppt === false ? "no" : "yes"}
              onChange={(e) => setDraft((d) => ({ ...d, multiMppt: e.target.value === "yes" }))}
            >
              <option value="yes">あり（入力ごとに別パネル可）</option>
              <option value="no">なし（全ストリング同一が必要）</option>
            </select>
          </div>
          <div className="field">
            <label>MPPTあたり最大並列数</label>
            <input type="number" value={draft.stringsPerMppt || ""} onChange={num("stringsPerMppt")} />
          </div>
          <div className="field">
            <label>最大入力電圧 Vdc,max</label>
            <input type="number" value={draft.maxInputVoltageV || ""} onChange={num("maxInputVoltageV")} />
          </div>
          <div className="field">
            <label>MPPT 電圧範囲 下限</label>
            <input type="number" value={draft.mpptVoltageMinV || ""} onChange={num("mpptVoltageMinV")} />
          </div>
          <div className="field">
            <label>MPPT 電圧範囲 上限</label>
            <input type="number" value={draft.mpptVoltageMaxV || ""} onChange={num("mpptVoltageMaxV")} />
          </div>
          <div className="field">
            <label>起動電圧 (任意)</label>
            <input type="number" value={draft.startVoltageV ?? ""} onChange={num("startVoltageV")} />
          </div>
          <div className="field">
            <label>MPPTあたり最大入力電流 (A)</label>
            <input type="number" step="0.1" value={draft.maxInputCurrentPerMpptA || ""} onChange={num("maxInputCurrentPerMpptA")} />
          </div>
          <div className="field">
            <label>単価 (円/台)</label>
            <input type="number" value={draft.unitPriceYen ?? ""} onChange={num("unitPriceYen")} />
          </div>
          <div className="field">
            <label>保証</label>
            <select
              value={draft.warranty ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, warranty: e.target.value }))}
            >
              {WARRANTY_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w === "" ? "未指定" : w}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label>備考</label>
            <input value={draft.note ?? ""} onChange={str("note")} />
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={submit}>
            {editing ? "更新" : "登録"}
          </button>
          {editing && (
            <button
              className="btn secondary"
              onClick={() => {
                setDraft(emptyPcs());
                setEditing(false);
              }}
            >
              キャンセル
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>登録済みパワコン（{store.pcsList.length}）</h2>
        {store.pcsList.length === 0 ? (
          <div className="empty">まだ登録がありません。</div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>メーカー / 型番</th>
                <th className="num">定格</th>
                <th className="num">MPPT</th>
                <th className="num">電圧範囲</th>
                <th className="num">最大電流</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {store.pcsList.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.maker}</div>
                    <strong>{p.model}</strong>
                    {p.warranty && (
                      <div>
                        <span className="badge new" style={{ marginTop: 2 }}>{p.warranty}</span>
                      </div>
                    )}
                  </td>
                  <td className="num">{p.ratedPowerKw} kW</td>
                  <td className="num">{p.mpptCount}×{p.stringsPerMppt}</td>
                  <td className="num">{p.mpptVoltageMinV}–{p.mpptVoltageMaxV} / {p.maxInputVoltageV}</td>
                  <td className="num">{p.maxInputCurrentPerMpptA} A</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className="btn secondary small" onClick={() => edit(p)}>編集</button>
                      <button className="btn secondary small" onClick={() => duplicate(p)} title="この内容をコピーして新規登録（保証・単価違いを作る）">複製</button>
                      <button className="btn danger small" onClick={() => removePcs(p)}>削除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
