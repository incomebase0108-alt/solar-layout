import { useState } from "react";
import { PanelRegistry } from "./components/PanelRegistry";
import { PcsRegistry } from "./components/PcsRegistry";
import { StringCalculator } from "./components/StringCalculator";
import { LayoutEditor } from "./components/LayoutEditor";
import { PlantManager } from "./components/PlantManager";
import { WiringTable } from "./components/WiringTable";
import { Optimizer } from "./components/Optimizer";
import { CostEstimator } from "./components/CostEstimator";
import { usePanels, usePcsList, useConditions, usePlants, useCostRates } from "./store";

type Tab = "plant" | "layout" | "optimize" | "wiring" | "cost" | "panel" | "pcs" | "string";

const TABS: { key: Tab; label: string }[] = [
  { key: "plant", label: "発電所" },
  { key: "layout", label: "現況レイアウト" },
  { key: "optimize", label: "入換最適化" },
  { key: "wiring", label: "パワコン配線表" },
  { key: "cost", label: "概算コスト" },
  { key: "panel", label: "パネル登録" },
  { key: "pcs", label: "パワコン登録" },
  { key: "string", label: "ストリング計算" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("plant");
  const panelStore = usePanels();
  const pcsStore = usePcsList();
  const condStore = useConditions();
  const costStore = useCostRates();
  const plantStore = usePlants();
  const current = plantStore.current;

  return (
    <div className="app">
      <header className="app-header no-print">
        <h1>☀ ソーラーレイアウト設計支援</h1>
        <span className="sub">発電所別 図面 ＆ パワコン配線</span>
        <span className="spacer" />
        <div className="field" style={{ minWidth: 220 }}>
          <label>対象の発電所</label>
          <select
            value={plantStore.currentId}
            onChange={(e) => plantStore.setCurrentId(e.target.value)}
          >
            {plantStore.plants.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      </header>

      <nav className="tabs no-print">
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

      {tab === "plant" && (
        <PlantManager
          plants={plantStore.plants}
          currentId={plantStore.currentId}
          setCurrentId={plantStore.setCurrentId}
          addPlant={plantStore.addPlant}
          updatePlant={plantStore.updatePlant}
          deletePlant={plantStore.deletePlant}
        />
      )}
      {tab === "layout" && current && (
        <LayoutEditor
          panels={panelStore.panels}
          layout={current.layout}
          patch={plantStore.patchLayout}
        />
      )}
      {tab === "optimize" && current && (
        <Optimizer plant={current} panels={panelStore.panels} />
      )}
      {tab === "wiring" && current && (
        <WiringTable
          plant={current}
          panels={panelStore.panels}
          pcsList={pcsStore.pcsList}
          conditions={condStore.conditions}
          patchWiring={plantStore.patchWiring}
        />
      )}
      {tab === "cost" && current && (
        <CostEstimator
          key={current.id}
          plant={current}
          panels={panelStore.panels}
          pcsList={pcsStore.pcsList}
          costRates={costStore.costRates}
          setCostRates={costStore.setCostRates}
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
