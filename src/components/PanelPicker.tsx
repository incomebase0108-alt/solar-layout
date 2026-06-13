import { useMemo, useState } from "react";
import type { PanelSpec } from "../types";

interface Props {
  panels: PanelSpec[];
  /** 選択中のパネルid（未選択は ""） */
  value: string;
  onChange: (panelId: string) => void;
  /** 未選択（「選択してください」）を許可する（配置フォーム用） */
  allowEmpty?: boolean;
}

/**
 * パネル選択。登録パネルが増えても選びやすいよう、
 * メーカーと出力(W)で絞り込んでから型式を選ぶ3段選択。
 * 絞り込みは表示のためだけで、選択済みのパネルが絞り込み外になっても選択は維持される。
 */
export function PanelPicker({ panels, value, onChange, allowEmpty }: Props) {
  const [maker, setMaker] = useState(""); // "" = すべて
  const [watt, setWatt] = useState(""); // "" = すべて

  const makers = useMemo(
    () => [...new Set(panels.map((p) => p.maker))].sort((a, b) => a.localeCompare(b, "ja")),
    [panels]
  );
  const watts = useMemo(
    () =>
      [...new Set(panels.filter((p) => !maker || p.maker === maker).map((p) => p.pmaxW))].sort(
        (a, b) => a - b
      ),
    [panels, maker]
  );
  const filtered = panels.filter(
    (p) => (!maker || p.maker === maker) && (!watt || p.pmaxW === Number(watt))
  );
  // 絞り込みで現在の選択が一覧から外れても、選択自体は維持して先頭に表示する
  const selectedPanel = panels.find((p) => p.id === value) ?? null;
  const keepSelected = selectedPanel && !filtered.some((p) => p.id === value);

  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <select
        value={maker}
        onChange={(e) => {
          setMaker(e.target.value);
          setWatt(""); // メーカーを変えたら出力の絞り込みはリセット
        }}
        title="メーカーで絞り込み"
      >
        <option value="">メーカー: すべて</option>
        {makers.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <select value={watt} onChange={(e) => setWatt(e.target.value)} title="出力(W)で絞り込み">
        <option value="">出力: すべて</option>
        {watts.map((w) => (
          <option key={w} value={String(w)}>{w}W</option>
        ))}
      </select>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1, minWidth: 200 }}>
        {allowEmpty && <option value="">選択してください</option>}
        {keepSelected && selectedPanel && (
          <option value={selectedPanel.id}>
            {selectedPanel.maker} {selectedPanel.model}（{selectedPanel.pmaxW}W）
          </option>
        )}
        {filtered.map((p) => (
          <option key={p.id} value={p.id}>
            {p.maker} {p.model}（{p.pmaxW}W）
          </option>
        ))}
      </select>
    </div>
  );
}
