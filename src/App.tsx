import { useState } from "react";
import { PanelRegistry } from "./components/PanelRegistry";
import { PcsRegistry } from "./components/PcsRegistry";
import { StringCalculator } from "./components/StringCalculator";
import { LayoutEditor } from "./components/LayoutEditor";
import { usePanels, usePcsList, useConditions, useLayout } from "./store";

type Tab = "layout" | "panel" | "pcs" | "string";

const TABS: { key: Tab; label: string }[] = [
  { key: "layout", label: "現況レイアウト" },
  { key: "panel", label: "パネル登録" },
  { key: "pcs", label: "パワコン登録" },
  { key: "string", label: "ストリング計算" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("layout");
  const panelStore = usePanels();
  const pcsStore = usePcsList();
  const condStore = useConditions();
  const layoutStore = useLayout();

  return (
    <div className="app">
      <header className="app-header">
        <h1>☀ ソーラーレイアウト設計支援</h1>
        <span className="sub">マスタ登録 ＆ ストリング設計（直列/並列）</span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "layout" && (
        <LayoutEditor
          panels={panelStore.panels}
          layout={layoutStore.layout}
          patch={layoutStore.patch}
        />
      )}
      {tab === "panel" && <PanelRegistry store={panelStore} />}
      {tab === "pcs" && <PcsRegistry store={pcsStore} />}
      {tab === "string" && (
        <StringCalculator
          panels={panelStore.panels}
          pcsList={pcsStore.pcsList}
          conditions={condStore.conditions}
          setConditions={condStore.setConditions}
        />
      )}
    </div>
  );
}
