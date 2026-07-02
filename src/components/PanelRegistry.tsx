import { useState } from "react";
import type { PanelSpec, PowerPlant } from "../types";
import { uid } from "../store";
import { useConfirm, useToast } from "./ui/dialogs";

interface Props {
  store: {
    panels: PanelSpec[];
    upsert: (p: PanelSpec) => void;
    remove: (id: string) => void;
  };
  /** 削除時の参照チェック用。使用中のパネルを消すと kW・見積が黙って 0 扱いになるため。 */
  plants: PowerPlant[];
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

export function PanelRegistry({ store, plants }: Props) {
  const [draft, setDraft] = useState<PanelSpec>(emptyPanel());
  const [editing, setEditing] = useState(false);
  const confirmDlg = useConfirm();
  const toast = useToast();
  // W単価（円/W）。Pmax×W単価＝1枚価格 を自動計算するための入力欄の値。
  const [wattPrice, setWattPrice] = useState<string>("");

  const num =
    (key: keyof PanelSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setDraft((d) => ({ ...d, [key]: v === "" ? undefined : Number(v) }));
    };

  /** Pmax から W単価の表示値を作る（円/枚 ÷ W、小数2桁） */
  function wattPriceFrom(unit: number | undefined, pmax: number | undefined): string {
    if (!unit || !pmax) return "";
    return String(+(unit / pmax).toFixed(2));
  }

  /** W単価入力 → Pmax×W単価で 単価(円/枚) を自動計算 */
  function onWattPriceChange(e: React.ChangeEvent<HTMLInputElement>) {
    const wp = e.target.value;
    setWattPrice(wp);
    setDraft((d) => {
      if (wp === "") return { ...d, unitPriceYen: undefined };
      const w = Number(wp);
      if (d.pmaxW > 0 && !isNaN(w)) return { ...d, unitPriceYen: Math.round(d.pmaxW * w) };
      return d;
    });
  }

  /** 単価(円/枚)を直接編集 → W単価の表示を同期 */
  function onUnitPriceChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    const unit = v === "" ? undefined : Number(v);
    setDraft((d) => ({ ...d, unitPriceYen: unit }));
    setWattPrice(wattPriceFrom(unit, draft.pmaxW));
  }

  /** Pmax編集 → W単価が入っていれば 単価(円/枚) を再計算 */
  function onPmaxChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    const pmax = v === "" ? 0 : Number(v);
    setDraft((d) => {
      const next = { ...d, pmaxW: v === "" ? 0 : Number(v) };
      const w = Number(wattPrice);
      if (wattPrice !== "" && pmax > 0 && !isNaN(w)) next.unitPriceYen = Math.round(pmax * w);
      return next;
    });
  }
  const str =
    (key: keyof PanelSpec) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: e.target.value }));

  function submit() {
    if (!draft.model.trim()) {
      toast("型番を入力してください", "warn");
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
      // 空欄のまま保存すると低温Voc計算が NaN になり、直列超過チェックが効かなくなる
      tempCoeffVocPctPerC: Number(draft.tempCoeffVocPctPerC) || -0.27,
      tempCoeffPmaxPctPerC: Number(draft.tempCoeffPmaxPctPerC) || -0.34,
    });
    setDraft(emptyPanel());
    setWattPrice("");
    setEditing(false);
  }

  function edit(p: PanelSpec) {
    setDraft({ ...p });
    setWattPrice(wattPriceFrom(p.unitPriceYen, p.pmaxW));
    setEditing(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** このパネルを使っている発電所名（使用中の削除を止めるため）。 */
  function usedIn(id: string): string[] {
    return plants
      .filter(
        (pl) =>
          pl.layout.arrays.some(
            (a) => a.panelId === id || Object.values(a.cellPanels ?? {}).includes(id)
          ) ||
          (pl.layout.freePanels ?? []).some((f) => f.panelId === id) ||
          (pl.layout.manualCurrent ?? []).some((m) => m.panelId === id) ||
          (pl.pcsUnits ?? []).some((u) => (u.strings ?? []).some((s) => s.panelId === id)) ||
          pl.wiring?.panelId === id
      )
      .map((pl) => pl.name);
  }

  async function removePanel(p: PanelSpec) {
    const used = usedIn(p.id);
    if (used.length) {
      await confirmDlg({
        title: "削除できません",
        message: `${p.model} は次の発電所で使用中のため削除できません：\n・${used.join("\n・")}\n\n先に図面・パワコン構成から外してください。`,
        okLabel: "閉じる",
        hideCancel: true,
      });
      return;
    }
    if (await confirmDlg({ title: "パネルの削除", message: `${p.model} を削除しますか？`, okLabel: "削除する", danger: true })) store.remove(p.id);
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
            <input type="number" value={draft.pmaxW || ""} onChange={onPmaxChange} />
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
            <input type="number" step="0.01" value={draft.tempCoeffVocPctPerC ?? ""} onChange={num("tempCoeffVocPctPerC")} />
          </div>
          <div className="field">
            <label>Pmax 温度係数</label>
            <input type="number" step="0.01" value={draft.tempCoeffPmaxPctPerC ?? ""} onChange={num("tempCoeffPmaxPctPerC")} />
          </div>
          <div className="field">
            <label>W単価 (円/W)</label>
            <input
              type="number"
              step="0.1"
              placeholder="例) 25"
              value={wattPrice}
              onChange={onWattPriceChange}
            />
          </div>
          <div className="field">
            <label>単価 (円/枚)＝Pmax×W単価</label>
            <input type="number" value={draft.unitPriceYen ?? ""} onChange={onUnitPriceChange} />
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
                setWattPrice("");
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
                      <button className="btn danger small" onClick={() => removePanel(p)}>削除</button>
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
