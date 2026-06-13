import { useState } from "react";
import { PanelRegistry } from "./components/PanelRegistry";
import { PcsRegistry } from "./components/PcsRegistry";
import { StringCalculator } from "./components/StringCalculator";
import { LayoutEditor } from "./components/LayoutEditor";
import { PlantManager } from "./components/PlantManager";
import { PcsComposer } from "./components/PcsComposer";
import { CostEstimator } from "./components/CostEstimator";
import { Guide } from "./components/Guide";
import { StepNav } from "./components/StepNav";
import { CandidateBar } from "./components/CandidateBar";
import { usePanels, usePcsList, useConditions, usePlants, useCostRates } from "./store";

const GUIDE_KEY = "solar-layout.onboarded";

type Tab = "plant" | "layout" | "pcsunits" | "cost" | "panel" | "pcs" | "string";

export default function App() {
  const [tab, setTab] = useState<Tab>("plant");
  const panelStore = usePanels();
  const pcsStore = usePcsList();
  const condStore = useConditions();
  const costStore = useCostRates();
  const plantStore = usePlants();
  const current = plantStore.current;

  // 初めて使う人向けガイド（初回は自動表示／「次回から表示しない」で抑制／❓使い方で再表示）
  const [showGuide, setShowGuide] = useState(() => {
    try { return localStorage.getItem(GUIDE_KEY) !== "1"; } catch { return true; }
  });
  function dontShowGuideAgain() {
    try { localStorage.setItem(GUIDE_KEY, "1"); } catch { /* ignore */ }
    setShowGuide(false);
  }

  return (
    <div className="app">
      <Guide
        open={showGuide}
        onClose={() => setShowGuide(false)}
        onDontShowAgain={dontShowGuideAgain}
        goTo={(t) => setTab(t as Tab)}
      />
      <header className="app-header no-print">
        <h1>☀ ソーラーレイアウト設計支援</h1>
        <span className="sub">発電所別 図面 ＆ パワコン配線</span>
        <span className="spacer" />
        <button className="btn secondary small" onClick={() => setShowGuide(true)} title="使い方ガイドを開く">
          ❓ 使い方
        </button>
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

      <StepNav tab={tab} setTab={(t) => setTab(t as Tab)} current={current ?? null} />

      {/* 候補（プラン）切替バー。図面タブでは②変更の検討フェーズ内に表示するため LayoutEditor へ渡す */}
      {current && (tab === "pcsunits" || tab === "cost") && (
        <CandidateBar
          plant={current}
          switchCandidate={plantStore.switchCandidate}
          addCandidate={plantStore.addCandidate}
          renameCandidate={plantStore.renameCandidate}
          deleteCandidate={plantStore.deleteCandidate}
        />
      )}

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
          key={current.id + ":" + (current.currentCandidateId ?? "")}
          panels={panelStore.panels}
          layout={current.layout}
          patch={plantStore.patchLayout}
          defaultAddress={current.address}
          pcsUnits={current.pcsUnits}
          pcsList={pcsStore.pcsList}
          plantName={current.name}
          customerName={current.customerName}
          hasCandidates={(current.candidates?.length ?? 0) > 0}
          candidateCount={current.candidates?.length ?? 0}
          clearCandidates={plantStore.clearCandidates}
          candidateBar={
            <CandidateBar
              plant={current}
              switchCandidate={plantStore.switchCandidate}
              addCandidate={plantStore.addCandidate}
              renameCandidate={plantStore.renameCandidate}
              deleteCandidate={plantStore.deleteCandidate}
            />
          }
        />
      )}
      {tab === "pcsunits" && current && (
        <PcsComposer
          plant={current}
          panels={panelStore.panels}
          pcsList={pcsStore.pcsList}
          conditions={condStore.conditions}
          updatePlant={plantStore.updatePlant}
        />
      )}
      {tab === "cost" && current && (
        <CostEstimator
          key={current.id + ":" + (current.currentCandidateId ?? "")}
          plant={current}
          panels={panelStore.panels}
          pcsList={pcsStore.pcsList}
          costRates={costStore.costRates}
          setCostRates={costStore.setCostRates}
          updatePlant={plantStore.updatePlant}
        />
      )}
      {tab === "panel" && <PanelRegistry store={panelStore} plants={plantStore.plants} />}
      {tab === "pcs" && <PcsRegistry store={pcsStore} plants={plantStore.plants} />}
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
