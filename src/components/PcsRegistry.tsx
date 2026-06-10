import { useState } from "react";
import type { PcsSpec } from "../types";
import { uid } from "../store";

interface Props {
  store: {
    pcsList: PcsSpec[];
    upsert: (p: PcsSpec) => void;
    remove: (id: string) => void;
  };
}

function emptyPcs(): PcsSpec {
  return {
    id: uid("pcs"),
    maker: "",
    model: "",
    kind: "new",
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
    note: "",
  };
}

export function PcsRegistry({ store }: Props) {
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
    store.upsert(draft);
    setDraft(emptyPcs());
    setEditing(false);
  }

  function edit(p: PcsSpec) {
    setDraft({ ...p });
    setEditing(true);
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
            <label>区分</label>
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft((d) => ({ ...d, kind: e.target.value as PcsSpec["kind"] }))
              }
            >
              <option value="existing">既設流用</option>
              <option value="new">新設</option>
            </select>
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
                <th>区分</th>
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
                  </td>
                  <td>
                    <span className={`badge ${p.kind}`}>
                      {p.kind === "existing" ? "既設" : "新設"}
                    </span>
                  </td>
                  <td className="num">{p.ratedPowerKw} kW</td>
                  <td className="num">{p.mpptCount}×{p.stringsPerMppt}</td>
                  <td className="num">{p.mpptVoltageMinV}–{p.mpptVoltageMaxV} / {p.maxInputVoltageV}</td>
                  <td className="num">{p.maxInputCurrentPerMpptA} A</td>
                  <td className="num">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button className="btn secondary small" onClick={() => edit(p)}>編集</button>
                      <button className="btn danger small" onClick={() => confirm(`${p.model} を削除しますか？`) && store.remove(p.id)}>削除</button>
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
