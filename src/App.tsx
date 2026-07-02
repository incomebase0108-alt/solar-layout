import { useEffect, useRef, useState } from "react";
import { exportAll, shouldRemindBackup, recordDataChange } from "./utils/backup";
import { PanelRegistry } from "./components/PanelRegistry";
import { PcsRegistry } from "./components/PcsRegistry";
import { StringCalculator } from "./components/StringCalculator";
import { LayoutEditor } from "./components/LayoutEditor";
import { PlantManager } from "./components/PlantManager";
import { PcsComposer } from "./components/PcsComposer";
import { CostEstimator } from "./components/CostEstimator";
import { Guide } from "./components/Guide";
import { StepNav, EmptyState } from "./components/StepNav";
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

  // ===== バックアップ促し =====
  // データはこのブラウザ内（localStorage / IndexedDB）だけに保存される。クリアや故障で
  // 消えるため、保存後に編集があり一定期間バックアップしていなければバナーで促す。
  const [remindBackup, setRemindBackup] = useState(false);
  const [backupDismissed, setBackupDismissed] = useState(false);
  const fpRef = useRef<string | null>(null);
  // 画像（imageDataUrl）は IndexedDB 側で出入りするため指紋から除外し、
  // 起動時のhydration/移行を「ユーザー編集」と誤検知しないようにする。
  const dataFingerprint = JSON.stringify([
    plantStore.plants.map((p) => ({ ...p, layout: { ...p.layout, imageDataUrl: 0 } })),
    panelStore.panels,
    pcsStore.pcsList,
    condStore.conditions,
    costStore.costRates,
  ]);
  useEffect(() => {
    if (fpRef.current === null) {
      fpRef.current = dataFingerprint; // 初回マウントは編集とみなさない
    } else if (dataFingerprint !== fpRef.current) {
      fpRef.current = dataFingerprint;
      recordDataChange();
    }
    setRemindBackup(shouldRemindBackup());
  }, [dataFingerprint, tab]);

  async function doBackup() {
    await exportAll();
    setBackupDismissed(false);
    setRemindBackup(shouldRemindBackup());
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

      {remindBackup && !backupDismissed && (
        <div
          className="card no-print"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            borderColor: "var(--warn)",
            background: "rgba(245,158,11,0.10)",
          }}
        >
          <span>
            💾 編集内容がまだバックアップされていません。データは<strong>このブラウザ内だけ</strong>に保存されています。
            念のためファイルに保存しておきましょう。
          </span>
          <span className="spacer" />
          <button className="btn small" onClick={doBackup}>💾 今すぐバックアップ</button>
          <button className="btn secondary small" title="今は閉じる" onClick={() => setBackupDismissed(true)}>×</button>
        </div>
      )}

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
          setImage={plantStore.setCurrentImage}
          defaultAddress={current.address}
          pcsUnits={current.pcsUnits}
          pcsList={pcsStore.pcsList}
          conditions={condStore.conditions}
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
          goToTab={(t) => setTab(t as Tab)}
        />
      )}
      {/* 発電所が未選択のとき②〜④が真っ白にならないよう空状態を表示（迷子防止の安全網） */}
      {(tab === "layout" || tab === "pcsunits" || tab === "cost") && !current && (
        <EmptyState goPlant={() => setTab("plant")} />
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
