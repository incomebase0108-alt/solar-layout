import { useState } from "react";
import type { PanelSpec } from "../types";
import { uid } from "../store";

interface Props {
  store: {
    panels: PanelSpec[];
    upsert: (p: PanelSpec) => void;
    remove: (id: string) => void;
  };
}

function emptyPanel(): PanelSpec {
  return {
    id: uid("panel"),
    maker: "",
    model: "",
    lengthMm: 0,
    widthMm: 0,
    thicknessMm: undefined,
    weightKg: undefined,
    pmaxW: 0,
    vmpV: 0,
    impA: 0,
    vocV: 0,
    iscA: 0,
    tempCoeffVocPctPerC: -0.27,
    tempCoeffPmaxPctPerC: -0.34,
    unitPriceYen: undefined,
    note: "",
  };
}

export function PanelRegistry({ store }: Props) {
  const [draft, setDraft] = useState<PanelSpec>(emptyPanel());
  const [editing, setEditing] = useState(false);

  const num =
    (key: keyof PanelSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft((d) => ({ ...d, [key]: v === "" ? undefined : Number(v) }));
    };
  const str =
    (key: keyof PanelSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  function submit() {
    if (!draft.model.trim()) {
      alert("型番を入力してください");
      return;
    }
    store.upsert({
      ...draft,
      lengthMm: Number(draft.lengthMm) || 0,
      widthMm: Number(draft.widthMm) || 0,
      pmaxW: Number(draft.pmaxW) || 0,
      vmpV: Number(draft.vmpV) || 0,
      impA: Number(draft.impA) || 0,
      vocV: Number(draft.vocV) || 0,
      iscA: Number(draft.iscA) || 0,
    });
    setDraft(emptyPanel());
    setEditing(false);
  }

  function edit(p: PanelSpec) {
    setDraft({ ...p });
    setEditing(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <>
      <div className="card">
        <h2>{editing ? "パネル編集" : "パネル登録"}</h2>

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
        </div>

        <h3>寸法（mm）— レイアウト用</h3>
        <div className="form-grid">
          <div className="field">
            <label>長辺 length</label>
            <input type="number" value={draft.lengthMm || ""} onChange={num("lengthMm")} />
          </div>
          <div className="field">
            <label>短辺 width</label>
            <input type="number" value={draft.widthMm || ""} onChange={num("widthMm")} />
          </div>
          <div className="field">
            <label>厚さ</label>
            <input type="number" value={draft.thicknessMm ?? ""} onChange={num("thicknessMm")} />
          </div>
          <div className="field">
            <label>重量 kg</label>
            <input type="number" value={draft.weightKg ?? ""} onChange={num("weightKg")} />
          </div>
        </div>

        <h3>電気特性（STC）— ストリング設計用</h3>
        <div className="form-grid">
          <div className="field">
            <label>Pmax (W)</label>
            <input type="number" value={draft.pmaxW || ""} onChange={num("pmaxW")} />
          </div>
          <div className="field">
            <label>Vmp (V)</label>
            <input type="number" step="0.1" value={draft.vmpV || ""} onChange={num("vmpV")} />
          </div>
          <div className="field">
            <label>Imp (A)</label>
            <input type="number" step="0.01" value={draft.impA || ""} onChange={num("impA")} />
          </div>
          <div className="field">
            <label>Voc (V)</label>
            <input type="number" step="0.1" value={draft.vocV || ""} onChange={num("vocV")} />
          </div>
          <div className="field">
            <label>Isc (A)</label>
            <input type="number" step="0.01" value={draft.iscA || ""} onChange={num("iscA")} />
          </div>
        </div>

        <h3>温度特性（%/℃）</h3>
        <div className="form-grid">
          <div className="field">
            <label>Voc 温度係数 β</label>
            <input type="number" step="0.01" value={draft.tempCoeffVocPctPerC} onChange={num("tempCoeffVocPctPerC")} />
          </div>
          <div className="field">
            <label>Pmax 温度係数</label>
            <input type="number" step="0.01" value={draft.tempCoeffPmaxPctPerC ?? ""} onChange={num("tempCoeffPmaxPctPerC")} />
          </div>
          <div className="field">
            <label>単価 (円/枚)</label>
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
                setDraft(emptyPanel());
                setEditing(false);
              }}
            >
              キャンセル
            </button>
          )}
        </div>
      </div>

      <div className="card">
        <h2>登録済みパネル（{store.panels.length}）</h2>
        {store.panels.length === 0 ? (
          <div className="empty">まだ登録がありません。</div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>メーカー / 型番</th>
                <th className="num">寸法 mm</th>
                <th className="num">Pmax</th>
                <th className="num">Vmp/Imp</th>
                <th className="num">Voc/Isc</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {store.panels.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div>{p.maker}</div>
                    <strong>{p.model}</strong>
                  </td>
                  <td className="num">{p.lengthMm}×{p.widthMm}</td>
                  <td className="num">{p.pmaxW} W</td>
                  <td className="num">{p.vmpV} / {p.impA}</td>
                  <td className="num">{p.vocV} / {p.iscA}</td>
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
