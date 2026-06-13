import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelSpec, LayoutProject, PanelArray, ShadowZone, FreePanel, LegendItem, PcsUnitLine, PcsSpec } from "../types";
import { cellKey, arrayGaps } from "../types";
import { shadedCellKeys, pointInZones } from "../calc/shadow";
import { summarizeLayout, arrayCellStats } from "../calc/layoutCount";
import { assignWiring, type WiringAssignResult } from "../calc/wiringAssign";
import { fileToScaledDataUrl } from "../utils/image";
import { geocodeAddress, buildSeamlessPhoto, calibrationFromScale } from "../utils/gsiMap";
import { uid } from "../store";
import { PanelPicker } from "./PanelPicker";

const KEEP_COLOR = "#22c55e"; // 流用（変更しない）パネルの色

interface Props {
  panels: PanelSpec[];
  layout: LayoutProject;
  patch: (p: Partial<LayoutProject>) => void;
  /** 発電所の住所（住所→地図の初期値） */
  defaultAddress?: string;
  /** パワコン構成（結線図の割付に使用） */
  pcsUnits?: PcsUnitLine[];
  /** パワコンマスタ（工事説明書のパワコン構成表に使用） */
  pcsList?: PcsSpec[];
  /** 発電所名（工事説明書の表紙に使用） */
  plantName?: string;
  /** 顧客名（工事説明書の表紙に使用） */
  customerName?: string;
  /** 検討候補（プラン）切替バー。②変更の検討フェーズの先頭に表示する */
  candidateBar?: ReactNode;
  /** 検討候補を使っているか（候補の切替・追加で再マウントしても②フェーズを維持するため） */
  hasCandidates?: boolean;
  /** 検討候補の件数（既設変更の確認メッセージに表示） */
  candidateCount?: number;
  /** 全候補を削除する（既設変更の確認OK時に呼ぶ） */
  clearCandidates?: () => void;
}

interface View {
  tx: number;
  ty: number;
  zoom: number;
}

// 配列の色。ピンク(#f472b6)は単独パネル専用のため使わない（混同防止）
const ARRAY_COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#a78bfa", "#2dd4bf"];

/** 配列の表示色。旧データでピンク（現在は単独パネル専用色）の配列は表示時だけ読み替える。 */
function arrayDispColor(c: string): string {
  return c === "#f472b6" ? "#2dd4bf" : c;
}

/**
 * フェーズの引き継ぎ（モジュールスコープ）。
 * 図面タブを開いたときは必ず①既設の設定から始めるが、候補切替・候補追加では
 * コンポーネントが即時に作り直されるため、その瞬間は直前のフェーズ（②など）を引き継ぐ。
 * 仕組み：表示中は常に最新フェーズをここへ共有し（新インスタンスの初期化が
 * 旧インスタンスの後始末より先に走るため、預けるのは後始末では間に合わない）、
 * アンマウント後すぐ再マウントされなければタブ離脱とみなして破棄→次に開くと①。
 */
let lastPhase: "kisetsu" | "henkou" | null = null;
let lastPhaseClearTimer: number | undefined;

/** 角度を (-180, 180] に正規化 */
function normalizeDeg(d: number): number {
  let x = ((d % 360) + 360) % 360;
  if (x > 180) x -= 360;
  return x;
}

/**
 * rows×cols の全セルキー。
 * ①既設の設定で作った配列には作成時に全セルの流用マークを付ける（＝既設扱い）。
 * ②変更の検討で追加した配列はマーク無し（＝新設扱い）。概算コスト・前後比較の判定に使う。
 */
function allCellKeys(rows: number, cols: number): string[] {
  const keys: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) keys.push(cellKey(r, c));
  return keys;
}

export function LayoutEditor({ panels, layout, patch: rawPatch, defaultAddress, pcsUnits, pcsList, plantName, customerName, candidateBar, hasCandidates, candidateCount, clearCandidates }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);

  // 元に戻す（Undo）用の履歴。変更前の layout を積む。
  // 既存の patch 呼び出しはすべてこのラッパ経由になり、自動で履歴対象になる。
  const historyRef = useRef<LayoutProject[]>([]);
  const [histLen, setHistLen] = useState(0);
  // ドラッグ・スライダーは mousemove/onChange 毎に発火するため、そのまま積むと
  // 1操作で履歴50件を食い潰して過去に戻れなくなる。連続操作は1件に合体させる。
  const gestureRef = useRef<{ name: string; t: number } | null>(null);
  const pushHistory = () => {
    historyRef.current.push(layout);
    if (historyRef.current.length > 50) historyRef.current.shift();
    setHistLen(historyRef.current.length);
  };
  const patch = (p: Partial<LayoutProject>) => {
    gestureRef.current = null; // 単発操作。次の連続操作は新しい履歴になる
    pushHistory();
    rawPatch(p);
  };
  /** 連続発火する操作（ドラッグ・スライダー）用。同じ操作が短時間続く間は履歴を1件だけ積む。 */
  const patchContinuous = (gesture: string, p: Partial<LayoutProject>) => {
    const now = Date.now();
    const g = gestureRef.current;
    if (!g || g.name !== gesture || now - g.t > 1500) pushHistory();
    gestureRef.current = { name: gesture, t: now };
    rawPatch(p);
  };
  function undo() {
    const prev = historyRef.current.pop();
    setHistLen(historyRef.current.length);
    if (prev) rawPatch(prev); // 履歴に積まずに丸ごと復元
  }
  const [view, setView] = useState<View>({ tx: 40, ty: 40, zoom: 0.5 });
  const [mode, setMode] = useState<"pan" | "calibrate" | "select" | "shadow" | "remove" | "scan" | "keeprect" | "removerect" | "cellpanel" | "missing" | "missrect" | "areaselect">("pan");
  // 作業フェーズ：①既設の設定（現況図面づくり）と ②変更の検討（流用・撤去・結線）を分けて表示する。
  // 図面タブを開いたときは①から始める（既定）。候補切替等の即時再マウント時のみ直前のフェーズを引き継ぐ。
  const [phase, setPhase] = useState<"kisetsu" | "henkou">(() => lastPhase ?? "kisetsu");
  useEffect(() => {
    // 表示中は常に最新フェーズを共有（候補切替の再マウントで新インスタンスがこれを読む）
    lastPhase = phase;
  }, [phase]);
  useEffect(() => {
    // マウント時：タブ離脱とみなすクリア予約があれば解除（＝即時再マウントだった）
    if (lastPhaseClearTimer !== undefined) {
      clearTimeout(lastPhaseClearTimer);
      lastPhaseClearTimer = undefined;
    }
    return () => {
      // アンマウント時：すぐ再マウントされなければタブ離脱→破棄して次回は①から
      lastPhaseClearTimer = window.setTimeout(() => {
        lastPhase = null;
        lastPhaseClearTimer = undefined;
      }, 300);
    };
  }, []);
  function switchPhase(p: "kisetsu" | "henkou") {
    setPhase(p);
    setMode("pan"); // フェーズ専用の編集モードを持ち越さない
    setSelectedId(null); // ①は既設のみ表示のため、非表示の新設を選択したまま持ち越さない
    setSelectedFreeId(null);
    setSelection(null); // エリア選択も持ち越さない（①と②で対象が違うため）
    if (p === "kisetsu") {
      setWireMode(false);
      setWireEdit(false);
    }
  }
  // 既設（地図・写真・校正・向き）は全候補で共有しているため、候補がある状態で変更すると
  // 全候補の前提（座標・縮尺・下絵）が一斉に狂う。そこでロックはせず、
  // 変更しようとしたら「全候補が削除されます」と確認し、OKなら候補を一掃してから実行する。
  // レイアウト以外（基準登録の取り直し等）は対象外＝自由に変更できる。
  const sharedChangeOkRef = useRef(false);
  useEffect(() => {
    // 候補が（再び）作られたら、次の既設変更時にまた確認を出す
    if (hasCandidates) sharedChangeOkRef.current = false;
  }, [hasCandidates]);
  /** 候補がある状態で既設を変更する前の確認。OKなら全候補を削除して true を返す。 */
  function confirmSharedChange(): boolean {
    if (!hasCandidates || sharedChangeOkRef.current) return true;
    const n = candidateCount ?? 0;
    if (
      !confirm(
        `既設（地図・写真・校正・向き）を変更すると、検討候補${n ? `（${n}件）` : ""}が全て削除されます。\n` +
          "いま画面に表示中の内容だけが残ります。続行しますか？"
      )
    )
      return false;
    sharedChangeOkRef.current = true;
    clearCandidates?.();
    return true;
  }
  // セル単位でパネル型式を変更するときの割り当て先パネルid
  const [cellPanelTarget, setCellPanelTarget] = useState(() => panels[0]?.id ?? "");
  // 範囲ドラッグで流用/入換を一括指定するときの値（true=流用にする, false=入換にする）
  const [keepRectValue, setKeepRectValue] = useState(true);
  // 範囲ドラッグで撤去/復活するときの値（true=撤去する, false=戻す）
  const [removeRectValue, setRemoveRectValue] = useState(true);
  // 範囲ドラッグで欠け（パネルの無い所）を削る/戻すときの値（true=削る, false=戻す）
  const [missRectValue, setMissRectValue] = useState(true);
  // 右クリックメニュー（セル単位の編集をマウス位置で行う）。x/y はキャンバス内の画面座標
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; arrId: string; r: number; col: number } | null>(null);
  // 右クリックメニューから入った範囲モードは、1回適用したら自動でパンに戻す
  const rectOnceRef = useRef(false);
  // ===== エリア選択（select-then-act）=====
  // ドラッグで選択 → セル集合として保持 → アクションパネルでまとめて操作する。
  // 配列ID → 選択セルキーの配列。null＝選択なし
  const [selection, setSelection] = useState<Record<string, string[]> | null>(null);
  // アクションパネルで選ぶ型式（載せ替え・塗り用）
  const [selPanelId, setSelPanelId] = useState("");
  // パネルにマウスを乗せたとき、メーカー名・型式を表示するツールチップ（同じ360Wでもジンコ/トリナ等を判別）
  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; label: string } | null>(null);
  // 操作結果メッセージ（撤去・載せ替え等の後にキャンバス上へ一時表示）
  const [opMsg, setOpMsg] = useState<string | null>(null);
  const opMsgTimer = useRef<number | undefined>(undefined);
  /** 操作結果を画面に出す（数秒で自動的に消える）。 */
  function flashMsg(text: string) {
    setOpMsg(text);
    if (opMsgTimer.current !== undefined) clearTimeout(opMsgTimer.current);
    opMsgTimer.current = window.setTimeout(() => setOpMsg(null), 3500);
  }
  // Shift＋ドラッグ（どのモードからでも選択開始）中かどうか
  const areaDragRef = useRef(false);
  // 高速参照用（draw・操作で使う）
  const selSets = useMemo(() => {
    if (!selection) return null;
    return new Map(Object.entries(selection).map(([id, ks]) => [id, new Set(ks)]));
  }, [selection]);
  // 現状手入力の登録確認メッセージ
  const [manualMsg, setManualMsg] = useState<string | null>(null);
  // パネルにW値を表示するか
  const [showW, setShowW] = useState(true);
  // 結線表示モード（パワコン構成からストリングを自動割付して色＋番号で描画）
  const [wireMode, setWireMode] = useState(false);
  // 結線の手編集：true=クリックで上書き割付, 値は割付先
  const [wireEdit, setWireEdit] = useState(false);
  const [editPc, setEditPc] = useState(1);
  const [editStr, setEditStr] = useState(1);
  const [editPar, setEditPar] = useState(1);
  // 結線編集専用のUndo/Redo（全体の戻すとは独立）。クリック位置にボタンを出す。
  const wireUndoRef = useRef<Record<string, { pcsNo: number; stringNo: number; parallelNo: number }>[]>([]);
  const wireRedoRef = useRef<Record<string, { pcsNo: number; stringNo: number; parallelNo: number }>[]>([]);
  const [wireHist, setWireHist] = useState(0); // ボタン活性の再描画用
  const [wirePopPos, setWirePopPos] = useState<{ x: number; y: number } | null>(null);

  /** 結線上書きを更新（全体履歴には積まず、結線専用履歴で管理）。 */
  function setWiringOverrides(next: Record<string, { pcsNo: number; stringNo: number; parallelNo: number }>, record = true) {
    if (record) {
      wireUndoRef.current.push(layout.wiringOverrides ?? {});
      if (wireUndoRef.current.length > 100) wireUndoRef.current.shift();
      wireRedoRef.current = [];
    }
    setWireHist((h) => h + 1);
    rawPatch({ wiringOverrides: next });
  }
  function wireUndo() {
    if (!wireUndoRef.current.length) return;
    const prev = wireUndoRef.current.pop()!;
    wireRedoRef.current.push(layout.wiringOverrides ?? {});
    setWireHist((h) => h + 1);
    rawPatch({ wiringOverrides: prev });
  }
  function wireRedo() {
    if (!wireRedoRef.current.length) return;
    const next = wireRedoRef.current.pop()!;
    wireUndoRef.current.push(layout.wiringOverrides ?? {});
    setWireHist((h) => h + 1);
    rawPatch({ wiringOverrides: next });
  }
  const wiring: WiringAssignResult | null = useMemo(
    () => (wireMode ? assignWiring(layout, panels, pcsUnits ?? [], layout.wiringOverrides) : null),
    [wireMode, layout, panels, pcsUnits]
  );

  // 住所 → 地理院タイル取得
  const [address, setAddress] = useState(defaultAddress ?? "");
  const [gsiZoom, setGsiZoom] = useState(18);
  const [gsiSpan, setGsiSpan] = useState(250); // 取得する一辺(m)目安
  const [gsiBusy, setGsiBusy] = useState(false);
  const [gsiMsg, setGsiMsg] = useState<string | null>(null);
  const [calibPts, setCalibPts] = useState<{ x: number; y: number }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFreeId, setSelectedFreeId] = useState<string | null>(null);
  const [shadowDraft, setShadowDraft] = useState<ShadowZone | null>(null);
  // スキャン：画面（スクリーン）座標の選択矩形。回転後の見た目に沿ってグリッドを作る。
  const [scanDraft, setScanDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // 配置フォーム
  // パネル未選択（""）が既定。選択しないと配列・単独パネルは追加できない（各追加関数でガード）
  const [formPanelId, setFormPanelId] = useState("");
  const [formOrient, setFormOrient] = useState<"portrait" | "landscape">("landscape"); // 既定は横置き
  const [formRows, setFormRows] = useState(4); // 低圧の既設アレイは4段が多いため既定4
  const [formCols, setFormCols] = useState(10);
  const [formGapX, setFormGapX] = useState(0.02); // 横方向（列の左右）の隙間 m
  const [formGapY, setFormGapY] = useState(0.02); // 縦方向（行の前後）の隙間 m

  const rot = (layout.imageRotationDeg * Math.PI) / 180;

  // --- 画像読み込み ---
  useEffect(() => {
    if (!layout.imageDataUrl) {
      imgRef.current = null;
      setImgReady(false);
      return;
    }
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
      // パネルがあればその範囲に最大ズーム、無ければ写真全体
      if (layout.arrays.length > 0 || (layout.freePanels?.length ?? 0) > 0) fitToPanels();
      else fitToView(img);
    };
    img.src = layout.imageDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.imageDataUrl]);

  const fitToView = useCallback((img: HTMLImageElement) => {
    const c = canvasRef.current;
    if (!c) return;
    const zoom = Math.min(c.width / img.width, c.height / img.height) * 0.9;
    setView({
      tx: (c.width - img.width * zoom) / 2,
      ty: (c.height - img.height * zoom) / 2,
      zoom,
    });
  }, []);

  /** パネル設置範囲（配列＋単独パネル）に最大ズームして中央表示。パネルが無ければ全体表示。 */
  function fitToPanels() {
    const c = canvasRef.current;
    if (!c) return;
    const pts: { x: number; y: number }[] = [];
    for (const a of layout.arrays) {
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(a);
      const tW = a.cols * pw + (a.cols - 1) * gapXpx;
      const tH = a.rows * ph + (a.rows - 1) * gapYpx;
      const ar = (a.rotationDeg * Math.PI) / 180;
      const cs = Math.cos(ar);
      const sn = Math.sin(ar);
      for (const [lx, ly] of [[0, 0], [tW, 0], [0, tH], [tW, tH]] as const) {
        pts.push({ x: a.posXpx + cs * lx - sn * ly, y: a.posYpx + sn * lx + cs * ly });
      }
    }
    for (const f of layout.freePanels ?? []) {
      const { pw, ph } = freePanelPx(f);
      const rad = Math.max(pw, ph) / 2;
      pts.push({ x: f.posXpx - rad, y: f.posYpx - rad }, { x: f.posXpx + rad, y: f.posYpx + rad });
    }
    if (pts.length === 0) {
      if (imgRef.current) fitToView(imgRef.current);
      return;
    }
    // 表示フレーム（回転後）でのバウンディングボックスを求める
    const cs = Math.cos(rot);
    const sn = Math.sin(rot);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const qx = cs * p.x - sn * p.y;
      const qy = sn * p.x + cs * p.y;
      minX = Math.min(minX, qx); maxX = Math.max(maxX, qx);
      minY = Math.min(minY, qy); maxY = Math.max(maxY, qy);
    }
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const zoom = Math.max(0.05, Math.min(8, Math.min(c.width / bw, c.height / bh) * 0.85));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setView({ tx: c.width / 2 - zoom * cx, ty: c.height / 2 - zoom * cy, zoom });
  }

  // --- 座標変換 ---
  const screenToImage = useCallback(
    (sx: number, sy: number) => {
      const a = (sx - view.tx) / view.zoom;
      const b = (sy - view.ty) / view.zoom;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      return { x: cos * a + sin * b, y: -sin * a + cos * b };
    },
    [view, rot]
  );

  // 画像座標 → 画面座標（screenToImage の逆変換）
  const imageToScreen = useCallback(
    (px: number, py: number) => {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const rx = cos * px - sin * py;
      const ry = sin * px + cos * py;
      return { x: view.tx + view.zoom * rx, y: view.ty + view.zoom * ry };
    },
    [view, rot]
  );

  // --- スケール（px/m） ---
  const pixelsPerMeter = (() => {
    const cal = layout.calibration;
    if (!cal) return 50; // 未校正時の暫定値
    const len = Math.hypot(cal.x2 - cal.x1, cal.y2 - cal.y1);
    return cal.meters > 0 ? len / cal.meters : 50;
  })();

  // --- パネル配列の寸法 (px) ---
  const arrayPanelPx = useCallback(
    (arr: PanelArray) => {
      const panel = panels.find((p) => p.id === arr.panelId);
      const lenM = (panel?.lengthMm ?? 1700) / 1000;
      const widM = (panel?.widthMm ?? 1000) / 1000;
      const pw =
        (arr.orientation === "portrait" ? widM : lenM) * pixelsPerMeter;
      const ph =
        (arr.orientation === "portrait" ? lenM : widM) * pixelsPerMeter;
      const { gx, gy } = arrayGaps(arr);
      return { pw, ph, gapXpx: gx * pixelsPerMeter, gapYpx: gy * pixelsPerMeter };
    },
    [panels, pixelsPerMeter]
  );

  // 単独パネルの表示寸法(px)
  const freePanelPx = useCallback(
    (fp: { panelId: string; orientation: "portrait" | "landscape" }) => {
      const panel = panels.find((p) => p.id === fp.panelId);
      const lenM = (panel?.lengthMm ?? 1700) / 1000;
      const widM = (panel?.widthMm ?? 1000) / 1000;
      const pw = (fp.orientation === "portrait" ? widM : lenM) * pixelsPerMeter;
      const ph = (fp.orientation === "portrait" ? lenM : widM) * pixelsPerMeter;
      return { pw, ph };
    },
    [panels, pixelsPerMeter]
  );

  // --- 描画 ---
  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.translate(view.tx, view.ty);
    ctx.scale(view.zoom, view.zoom);
    ctx.rotate(rot);

    const img = imgRef.current;
    if (img) {
      ctx.globalAlpha = layout.imageOpacity;
      ctx.drawImage(img, 0, 0);
      ctx.globalAlpha = 1;
    }

    const zones = layout.shadowZones ?? [];

    // パネル配列
    for (const arr of layout.arrays) {
      // ①既設の設定は「改修前の既設だけ」を表示する：
      // ②で追加した新設配列は描かず、撤去・入換マークも無視して既設の満数で描く（汚染防止）
      if (phase === "kisetsu" && arr.keepCells === undefined) continue;
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      ctx.save();
      ctx.translate(arr.posXpx, arr.posYpx);
      ctx.rotate((arr.rotationDeg * Math.PI) / 180);
      const selected = arr.id === selectedId;
      const keep = new Set(arr.keepCells ?? []);
      const removed = new Set(arr.removedCells ?? []);
      const missing = new Set(arr.missingCells ?? []);
      const areaSel = selSets?.get(arr.id);
      const shaded = shadedCellKeys(arr, dims, zones);
      for (let r = 0; r < arr.rows; r++) {
        for (let col = 0; col < arr.cols; col++) {
          const x = col * (pw + gapXpx);
          const y = r * (ph + gapYpx);
          // 欠け（最初からパネルが無い）セルは描かない。編集モード中だけ赤破線のゴーストで示し、戻せるようにする
          if (missing.has(cellKey(r, col))) {
            if (mode === "missing" || mode === "missrect") {
              ctx.strokeStyle = "#f43f5e";
              ctx.lineWidth = 1 / view.zoom;
              ctx.setLineDash([3 / view.zoom, 3 / view.zoom]);
              ctx.strokeRect(x, y, pw, ph);
              ctx.setLineDash([]);
            }
            continue;
          }
          // 撤去セルは赤系の塗り＋×印で「撤去」と一目で分かるようにする（②のみ。①は既設満数で表示）
          if (phase === "henkou" && removed.has(cellKey(r, col))) {
            ctx.fillStyle = "rgba(244,63,94,0.30)"; // 赤の半透明
            ctx.fillRect(x, y, pw, ph);
            ctx.strokeStyle = "#f43f5e";
            ctx.lineWidth = 1.2 / view.zoom;
            ctx.strokeRect(x, y, pw, ph);
            // ×印（ズームが十分なときのみ）
            if (Math.min(pw, ph) * view.zoom >= 8) {
              ctx.beginPath();
              ctx.moveTo(x + pw * 0.2, y + ph * 0.2);
              ctx.lineTo(x + pw * 0.8, y + ph * 0.8);
              ctx.moveTo(x + pw * 0.8, y + ph * 0.2);
              ctx.lineTo(x + pw * 0.2, y + ph * 0.8);
              ctx.stroke();
            }
            // 選択中なら白枠を重ねて「選択は維持されている」ことを示す
            if (areaSel?.has(cellKey(r, col))) {
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 2 / view.zoom;
              ctx.strokeRect(x, y, pw, ph);
            }
            continue;
          }
          // --- 結線表示モード：パワコン別に色分け＋「PC番号-ストリング番号」 ---
          if (wiring) {
            const ckey = `${arr.id}:${r},${col}`;
            // 改修案の対象外（入換で撤去・置換される既存セル）は薄い破線枠のみ
            if (!wiring.targetCells.has(ckey)) {
              ctx.strokeStyle = "#334155";
              ctx.lineWidth = 1 / view.zoom;
              ctx.setLineDash([3 / view.zoom, 3 / view.zoom]);
              ctx.strokeRect(x, y, pw, ph);
              ctx.setLineDash([]);
              continue;
            }
            const as = wiring.byCell.get(ckey);
            if (as) {
              ctx.fillStyle = as.color + "cc";
              ctx.strokeStyle = "#0b1220";
              ctx.lineWidth = 1 / view.zoom;
              ctx.fillRect(x, y, pw, ph);
              ctx.strokeRect(x, y, pw, ph);
              if (shaded.has(cellKey(r, col))) {
                ctx.fillStyle = "rgba(15,23,42,0.35)";
                ctx.fillRect(x, y, pw, ph);
              }
              // ラベル「PC番号-ストリング番号-並列番号」（セルに合わせて文字サイズ）
              const label = `${as.pcsNo}-${as.stringNo}-${as.parallelNo}`;
              const fs = Math.min(ph * 0.4, (pw * 0.9) / Math.max(3, label.length * 0.55));
              if (fs * view.zoom >= 4) {
                ctx.fillStyle = "#0b1220";
                ctx.font = `bold ${fs}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(label, x + pw / 2, y + ph / 2);
                ctx.textAlign = "start";
                ctx.textBaseline = "alphabetic";
              }
            } else {
              // 改修案だがストリング未割付（パワコン構成の枚数不足）＝空き枠
              ctx.fillStyle = "rgba(148,163,184,0.18)";
              ctx.strokeStyle = "#475569";
              ctx.lineWidth = 1 / view.zoom;
              ctx.fillRect(x, y, pw, ph);
              ctx.strokeRect(x, y, pw, ph);
            }
            continue;
          }
          // 流用＝緑は②変更の検討でのみ表示（①は既設づくり中で全数流用のため色分け不要）
          const isKeep = phase === "henkou" && keep.has(cellKey(r, col));
          ctx.fillStyle = (isKeep ? KEEP_COLOR : arrayDispColor(arr.color)) + (isKeep ? "66" : "44");
          ctx.strokeStyle = isKeep ? KEEP_COLOR : selected ? "#fff" : arrayDispColor(arr.color);
          ctx.lineWidth = (isKeep ? 1.5 : selected ? 2 : 1) / view.zoom;
          ctx.fillRect(x, y, pw, ph);
          ctx.strokeRect(x, y, pw, ph);
          // 影に入るセルは暗くオーバーレイ
          if (shaded.has(cellKey(r, col))) {
            ctx.fillStyle = "rgba(15,23,42,0.55)";
            ctx.fillRect(x, y, pw, ph);
          }
          // パネルのW値を表示（混在セルは別型式のWを橙で）。ズーム十分なときのみ。
          const ovId = arr.cellPanels?.[cellKey(r, col)];
          const isOv = !!ovId && ovId !== arr.panelId;
          const effPanel = panels.find((p) => p.id === (isOv ? ovId : arr.panelId));
          if (isOv) {
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 2 / view.zoom;
            ctx.strokeRect(x + 1 / view.zoom, y + 1 / view.zoom, pw - 2 / view.zoom, ph - 2 / view.zoom);
          }
          const fsW = Math.min(ph * 0.4, pw * 0.42);
          if (showW && effPanel && fsW * view.zoom >= 5) {
            ctx.fillStyle = isOv ? "#f59e0b" : "#0b1220";
            ctx.font = `bold ${fsW}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(effPanel.pmaxW), x + pw / 2, y + ph / 2);
            ctx.textAlign = "start";
            ctx.textBaseline = "alphabetic";
          }
          // エリア選択中のセルは白ハイライト
          if (areaSel?.has(cellKey(r, col))) {
            ctx.fillStyle = "rgba(255,255,255,0.28)";
            ctx.fillRect(x, y, pw, ph);
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2 / view.zoom;
            ctx.strokeRect(x, y, pw, ph);
          }
        }
      }
      // 選択枠
      if (selected) {
        const totalW = arr.cols * pw + (arr.cols - 1) * gapXpx;
        const totalH = arr.rows * ph + (arr.rows - 1) * gapYpx;
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(-4, -4, totalW + 8, totalH + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // 単独パネル（新設扱いのため①既設の設定では表示しない）
    for (const fp of phase === "henkou" ? layout.freePanels ?? [] : []) {
      const { pw, ph } = freePanelPx(fp);
      ctx.save();
      ctx.translate(fp.posXpx, fp.posYpx);
      ctx.rotate((fp.rotationDeg * Math.PI) / 180);
      const sel = fp.id === selectedFreeId;
      ctx.fillStyle = fp.color + "66";
      ctx.strokeStyle = sel ? "#fff" : fp.color;
      ctx.lineWidth = (sel ? 2.5 : 1.5) / view.zoom;
      ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
      ctx.strokeRect(-pw / 2, -ph / 2, pw, ph);
      // 影
      const ctr = { x: fp.posXpx, y: fp.posYpx };
      if (pointInZones(ctr.x, ctr.y, zones)) {
        ctx.fillStyle = "rgba(15,23,42,0.55)";
        ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
      }
      // パネルのW値を表示（配列セルと同じ見せ方）。ズーム十分なときのみ。
      const fpPanel = panels.find((p) => p.id === fp.panelId);
      const fpFsW = Math.min(ph * 0.4, pw * 0.42);
      if (showW && fpPanel && fpFsW * view.zoom >= 5) {
        ctx.fillStyle = "#0b1220";
        ctx.font = `bold ${fpFsW}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(fpPanel.pmaxW), 0, 0);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }
      if (sel) {
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(-pw / 2 - 4, -ph / 2 - 4, pw + 8, ph + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // 校正線
    const cal = layout.calibration;
    if (cal) {
      drawLine(ctx, cal.x1, cal.y1, cal.x2, cal.y2, "#f43f5e", view.zoom);
    }
    if (calibPts.length === 1) {
      ctx.fillStyle = "#f43f5e";
      ctx.beginPath();
      ctx.arc(calibPts[0].x, calibPts[0].y, 5 / view.zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // 影ゾーン
    for (const z of zones) {
      ctx.fillStyle = "rgba(15,23,42,0.35)";
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
      ctx.strokeRect(z.x, z.y, z.w, z.h);
      ctx.setLineDash([]);
    }
    if (shadowDraft) {
      ctx.fillStyle = "rgba(14,165,233,0.2)";
      ctx.fillRect(shadowDraft.x, shadowDraft.y, shadowDraft.w, shadowDraft.h);
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 1.5 / view.zoom;
      ctx.strokeRect(shadowDraft.x, shadowDraft.y, shadowDraft.w, shadowDraft.h);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // スキャンの選択矩形（画面座標＝回転後の見た目に沿う）
    if (scanDraft) {
      ctx.fillStyle = "rgba(56,189,248,0.18)";
      ctx.fillRect(scanDraft.x, scanDraft.y, scanDraft.w, scanDraft.h);
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(scanDraft.x, scanDraft.y, scanDraft.w, scanDraft.h);
      ctx.setLineDash([]);
    }
  }, [view, rot, layout, selectedId, selectedFreeId, calibPts, shadowDraft, scanDraft, wiring, showW, arrayPanelPx, freePanelPx, phase, mode, selSets]);

  useEffect(() => {
    draw();
  }, [draw, imgReady]);

  // キャンバスサイズを親に合わせる
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const resize = () => {
      const parent = c.parentElement;
      if (!parent) return;
      c.width = parent.clientWidth;
      c.height = 620;
      draw();
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [draw]);

  // --- マウス操作 ---
  const dragRef = useRef<{
    kind: "pan" | "array" | "free";
    startSx: number;
    startSy: number;
    orig: { tx: number; ty: number } | { px: number; py: number };
    arrId?: string;
    freeId?: string;
  } | null>(null);
  const shadowStartRef = useRef<{ x: number; y: number } | null>(null);
  // スキャンの開始点（画面座標）
  const scanStartRef = useRef<{ sx: number; sy: number } | null>(null);

  function hitFree(ix: number, iy: number): FreePanel | null {
    if (phase === "kisetsu") return null; // ①では単独パネル（新設）は非表示＝操作対象外
    const fps = layout.freePanels ?? [];
    for (let i = fps.length - 1; i >= 0; i--) {
      const fp = fps[i];
      const { pw, ph } = freePanelPx(fp);
      const dx = ix - fp.posXpx;
      const dy = iy - fp.posYpx;
      const a = (-fp.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      if (Math.abs(lx) <= pw / 2 && Math.abs(ly) <= ph / 2) return fp;
    }
    return null;
  }

  function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): ShadowZone {
    return {
      id: "draft",
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(a.x - b.x),
      h: Math.abs(a.y - b.y),
    };
  }

  function hitArray(ix: number, iy: number): PanelArray | null {
    for (let i = layout.arrays.length - 1; i >= 0; i--) {
      const arr = layout.arrays[i];
      if (phase === "kisetsu" && arr.keepCells === undefined) continue; // ①では新設は非表示＝操作対象外
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(arr);
      const totalW = arr.cols * pw + (arr.cols - 1) * gapXpx;
      const totalH = arr.rows * ph + (arr.rows - 1) * gapYpx;
      const dx = ix - arr.posXpx;
      const dy = iy - arr.posYpx;
      const a = (-arr.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      if (lx >= 0 && lx <= totalW && ly >= 0 && ly <= totalH) return arr;
    }
    return null;
  }

  /** 画像座標から (配列, 行, 列) を求める。なければ null。 */
  function hitCell(ix: number, iy: number): { arr: PanelArray; r: number; col: number } | null {
    for (let i = layout.arrays.length - 1; i >= 0; i--) {
      const arr = layout.arrays[i];
      if (phase === "kisetsu" && arr.keepCells === undefined) continue; // ①では新設は非表示＝操作対象外
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(arr);
      const dx = ix - arr.posXpx;
      const dy = iy - arr.posYpx;
      const a = (-arr.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      const col = Math.floor(lx / (pw + gapXpx));
      const r = Math.floor(ly / (ph + gapYpx));
      if (r >= 0 && r < arr.rows && col >= 0 && col < arr.cols) {
        // セル内（隙間でない）か確認
        const cx = lx - col * (pw + gapXpx);
        const cy = ly - r * (ph + gapYpx);
        if (cx <= pw && cy <= ph) return { arr, r, col };
      }
    }
    return null;
  }

  function toggleCell(arr: PanelArray, r: number, col: number) {
    // 流用/入換マークは既設配列のみ（新設を既設化しない）。欠けセルは対象外
    if (arr.keepCells === undefined) return;
    const key = cellKey(r, col);
    if (new Set(arr.missingCells ?? []).has(key)) return;
    const keep = new Set(arr.keepCells ?? []);
    if (keep.has(key)) keep.delete(key);
    else keep.add(key);
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id ? { ...a, keepCells: [...keep] } : a
      ),
    });
  }

  function toggleRemove(arr: PanelArray, r: number, col: number) {
    const key = cellKey(r, col);
    if (new Set(arr.missingCells ?? []).has(key)) return; // 欠け（パネル無し）は撤去対象外
    const removed = new Set(arr.removedCells ?? []);
    if (removed.has(key)) removed.delete(key);
    else removed.add(key);
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id ? { ...a, removedCells: [...removed] } : a
      ),
    });
  }

  /** セルのパネル型式を割り当てる。配列の既定型式と同じなら上書きを解除。 */
  function setCellPanel(arr: PanelArray, r: number, col: number, panelId: string) {
    const key = cellKey(r, col);
    if (new Set(arr.missingCells ?? []).has(key)) return; // 欠け（パネル無し）には割り当てない
    const cp = { ...(arr.cellPanels ?? {}) };
    if (panelId === arr.panelId) delete cp[key];
    else cp[key] = panelId;
    patch({
      arrays: layout.arrays.map((a) => (a.id === arr.id ? { ...a, cellPanels: cp } : a)),
    });
  }

  // ===== エリア選択への一括操作（select-then-act） =====

  /** 選択セルを含む配列に変換を適用する共通処理。 */
  function applyToSelection(transform: (a: PanelArray, keys: Set<string>) => PanelArray) {
    if (!selSets) return;
    patch({
      arrays: layout.arrays.map((a) => {
        const keys = selSets.get(a.id);
        return keys?.size ? transform(a, keys) : a;
      }),
    });
  }

  /** 選択セルの合計枚数を数える（欠け除外）。 */
  function selCount(): number {
    if (!selSets) return 0;
    let n = 0;
    for (const [, keys] of selSets) n += keys.size;
    return n;
  }

  /** 選択を撤去（更地）にする（②）。 */
  function selRemove() {
    const n = selCount();
    applyToSelection((a, keys) => {
      const removed = new Set(a.removedCells ?? []);
      keys.forEach((k) => removed.add(k));
      return { ...a, removedCells: [...removed] };
    });
    flashMsg(`🗑 ${n}枚を撤去しました（更地・改修後から除外）`);
  }

  /** 選択を流用に戻す＝入換・撤去をまとめて取り消し（②・既設のみ）。 */
  function selRestore() {
    const n = selCount();
    applyToSelection((a, keys) => {
      if (a.keepCells === undefined) return a;
      const keep = new Set(a.keepCells);
      const removed = new Set(a.removedCells ?? []);
      keys.forEach((k) => {
        keep.add(k);
        removed.delete(k);
      });
      return { ...a, keepCells: [...keep], removedCells: a.removedCells ? [...removed] : undefined };
    });
    flashMsg(`↩ ${n}枚を流用（変更しない）に戻しました`);
  }

  /** 選択セルの型式を塗る（既設実体の混在修正。マスタ＝全候補共通）。 */
  function selPaint(pid: string) {
    if (!pid) return;
    const n = selCount();
    const p = panels.find((x) => x.id === pid);
    applyToSelection((a, keys) => {
      const cp = { ...(a.cellPanels ?? {}) };
      keys.forEach((k) => {
        if (pid === a.panelId) delete cp[k];
        else cp[k] = pid;
      });
      return { ...a, cellPanels: cp };
    });
    flashMsg(`🎨 ${n}枚を ${p ? `${p.model}（${p.pmaxW}W）` : "選択型式"} に変更しました`);
  }

  /** 選択を削る（欠け＝最初から無い所、①）。 */
  function selCarve() {
    const n = selCount();
    applyToSelection((a, keys) => {
      const missing = new Set(a.missingCells ?? []);
      const keep = a.keepCells ? new Set(a.keepCells) : null;
      const removed = new Set(a.removedCells ?? []);
      keys.forEach((k) => {
        missing.add(k);
        keep?.delete(k);
        removed.delete(k);
      });
      return {
        ...a,
        missingCells: missing.size ? [...missing] : undefined,
        keepCells: keep ? [...keep] : undefined,
        removedCells: a.removedCells ? [...removed] : undefined,
      };
    });
    setSelection(null); // 削ったセルは存在しなくなるので選択も解除
    flashMsg(`✂ ${n}枚を「パネル無し」にしました（枚数・コストから除外）`);
  }

  /**
   * 載せ替え（②の本命機能）：選択した既設セルを入換にし、
   * 同じ位置に選んだ型式の新設配列を自動生成する（非選択セルは欠けで形を合わせる）。
   * これまで手作業だった「撤去マーク＋新設配列を重ねて位置合わせ」を1コマンド化。
   */
  function selReplace(pid: string) {
    if (!pid || !selSets) return;
    const n = selCount();
    const p = panels.find((x) => x.id === pid);
    const newArrays: PanelArray[] = [];
    const updated = layout.arrays.map((a) => {
      const keys = selSets.get(a.id);
      if (!keys?.size) return a;
      if (a.keepCells === undefined) return a; // 新設配列は載せ替え対象外
      // 1) 選択セルを入換（流用解除）に
      const keep = new Set(a.keepCells);
      keys.forEach((k) => keep.delete(k));
      // 2) 選択範囲のバウンディングボックスで新設配列を同位置に生成
      let rmin = Infinity, rmax = -1, cmin = Infinity, cmax = -1;
      for (const k of keys) {
        const i = k.indexOf(",");
        const r = Number(k.slice(0, i));
        const c = Number(k.slice(i + 1));
        if (r < rmin) rmin = r;
        if (r > rmax) rmax = r;
        if (c < cmin) cmin = c;
        if (c > cmax) cmax = c;
      }
      const rows = rmax - rmin + 1;
      const cols = cmax - cmin + 1;
      const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(a);
      const rad = (a.rotationDeg * Math.PI) / 180;
      const lx = cmin * (pw + gapXpx);
      const ly = rmin * (ph + gapYpx);
      const missing: string[] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++)
          if (!keys.has(cellKey(r + rmin, c + cmin))) missing.push(cellKey(r, c));
      newArrays.push({
        id: uid("arr"),
        panelId: pid,
        orientation: a.orientation,
        rows,
        cols,
        gapM: a.gapM,
        gapYm: a.gapYm,
        posXpx: a.posXpx + Math.cos(rad) * lx - Math.sin(rad) * ly,
        posYpx: a.posYpx + Math.sin(rad) * lx + Math.cos(rad) * ly,
        rotationDeg: a.rotationDeg,
        color: ARRAY_COLORS[(layout.arrays.length + newArrays.length) % ARRAY_COLORS.length],
        ...(missing.length ? { missingCells: missing } : {}),
      });
      return { ...a, keepCells: [...keep] };
    });
    patch({ arrays: [...updated, ...newArrays] });
    setSelection(null);
    flashMsg(`⇄ ${n}枚を ${p ? `${p.model}（${p.pmaxW}W）` : "選択型式"} に載せ替えました（撤去${n}＋新設${n}）`);
  }

  /** 配列単位の撤去指定。removeAll=true で全パネルを撤去（更地・載せ替えなし）、false で撤去を全解除。
   *  欠け（最初から無いセル）は対象外。撤去は候補ごとのマークなので他の候補には影響しない。 */
  function setAllRemoved(arrId: string, removeAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== arrId) return a;
        if (!removeAll) return { ...a, removedCells: [] };
        const missing = new Set(a.missingCells ?? []);
        const all: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) {
            const k = cellKey(r, c);
            if (!missing.has(k)) all.push(k);
          }
        return { ...a, removedCells: all };
      }),
    });
  }

  /** 右クリック：クリックしたパネル（セル）の編集メニューをマウス位置に出す。 */
  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const img = screenToImage(sx, sy);
    const cell = hitCell(img.x, img.y);
    if (cell) {
      setSelectedId(cell.arr.id);
      setSelectedFreeId(null);
      setCtxMenu({ x: sx, y: sy, arrId: cell.arr.id, r: cell.r, col: cell.col });
    } else {
      setCtxMenu(null);
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    if (ctxMenu) setCtxMenu(null); // 左クリックでメニューを閉じる
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // エリア選択：選択モード中、または Shift＋ドラッグ（どのモードからでも）
    if (mode === "areaselect" || e.shiftKey) {
      areaDragRef.current = true;
      scanStartRef.current = { sx, sy };
      return;
    }

    // 結線の手編集：パネルをクリックで選択中の PC-ストリング-並列 に上書き割付
    if (wireMode && wireEdit) {
      setWirePopPos({ x: sx, y: sy }); // 戻す/進めるボタンをこの位置に出す
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell && wiring) {
        const key = `${cell.arr.id}:${cell.r},${cell.col}`;
        if (wiring.targetCells.has(key)) {
          const ov = { ...(layout.wiringOverrides ?? {}) };
          ov[key] = { pcsNo: editPc, stringNo: editStr, parallelNo: editPar };
          setWiringOverrides(ov);
        }
      }
      return;
    }

    if (mode === "shadow") {
      shadowStartRef.current = screenToImage(sx, sy);
      return;
    }

    if (mode === "scan" || mode === "keeprect" || mode === "removerect" || mode === "missrect") {
      // 画面座標で記録（回転後の見た目に沿って囲む）。scan/範囲流用/範囲撤去/範囲欠け で共用。
      scanStartRef.current = { sx, sy };
      return;
    }

    if (mode === "missing") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell) {
        setSelectedId(cell.arr.id);
        toggleMissing(cell.arr, cell.r, cell.col);
      }
      return;
    }

    if (mode === "select") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell) {
        setSelectedId(cell.arr.id);
        toggleCell(cell.arr, cell.r, cell.col);
      }
      return;
    }

    if (mode === "remove") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell) {
        setSelectedId(cell.arr.id);
        toggleRemove(cell.arr, cell.r, cell.col);
      }
      return;
    }

    if (mode === "cellpanel") {
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell && cellPanelTarget) {
        setSelectedId(cell.arr.id);
        setCellPanel(cell.arr, cell.r, cell.col, cellPanelTarget);
      }
      return;
    }

    if (mode === "calibrate") {
      const p = screenToImage(sx, sy);
      const next = [...calibPts, p];
      if (next.length === 2) {
        const m = prompt("この2点間の実際の距離 (m) を入力してください", "10");
        const meters = m ? Number(m) : NaN;
        if (meters > 0) {
          patch({
            calibration: { x1: next[0].x, y1: next[0].y, x2: next[1].x, y2: next[1].y, meters },
          });
        }
        setCalibPts([]);
        setMode("pan");
      } else {
        setCalibPts(next);
      }
      return;
    }

    const img = screenToImage(sx, sy);
    const free = hitFree(img.x, img.y);
    if (free) {
      setSelectedFreeId(free.id);
      setSelectedId(null);
      dragRef.current = {
        kind: "free",
        startSx: sx,
        startSy: sy,
        orig: { px: free.posXpx, py: free.posYpx },
        freeId: free.id,
      };
      return;
    }
    const hit = hitArray(img.x, img.y);
    if (hit) {
      setSelectedId(hit.id);
      setSelectedFreeId(null);
      dragRef.current = {
        kind: "array",
        startSx: sx,
        startSy: sy,
        orig: { px: hit.posXpx, py: hit.posYpx },
        arrId: hit.id,
      };
    } else {
      setSelectedId(null);
      setSelectedFreeId(null);
      setSelection(null); // 空白クリックでエリア選択を解除
      dragRef.current = {
        kind: "pan",
        startSx: sx,
        startSy: sy,
        orig: { tx: view.tx, ty: view.ty },
      };
    }
  }

  function onMouseMove(e: React.MouseEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // 影ゾーンのドラッグ矩形描画（画像座標）
    if (mode === "shadow" && shadowStartRef.current) {
      const cur = screenToImage(sx, sy);
      setShadowDraft(rectFrom(shadowStartRef.current, cur));
      return;
    }

    // スキャン／範囲流用／範囲撤去／範囲欠け／エリア選択のドラッグ矩形描画（画面座標＝回転後の見た目に沿う）
    if ((mode === "scan" || mode === "keeprect" || mode === "removerect" || mode === "missrect" || areaDragRef.current) && scanStartRef.current) {
      // ボタンを離したまま戻ってきた場合（キャンバス外でアップ）はドラフトを破棄
      if (!(e.buttons & 1)) {
        scanStartRef.current = null;
        areaDragRef.current = false;
        setScanDraft(null);
        return;
      }
      const s = scanStartRef.current;
      setScanDraft({
        x: Math.min(s.sx, sx),
        y: Math.min(s.sy, sy),
        w: Math.abs(sx - s.sx),
        h: Math.abs(sy - s.sy),
      });
      return;
    }

    const d = dragRef.current;
    if (!d) {
      // ドラッグしていないとき：パネルの上ならメーカー名・型式をツールチップ表示
      const img = screenToImage(sx, sy);
      const cell = hitCell(img.x, img.y);
      if (cell && !new Set(cell.arr.missingCells ?? []).has(cellKey(cell.r, cell.col))) {
        const pid = cell.arr.cellPanels?.[cellKey(cell.r, cell.col)] ?? cell.arr.panelId;
        const p = panels.find((x) => x.id === pid);
        setHoverInfo(p ? { x: sx, y: sy, label: `${p.maker} ${p.model}（${p.pmaxW}W）` } : null);
      } else if (hoverInfo) {
        setHoverInfo(null);
      }
      return;
    }
    if (hoverInfo) setHoverInfo(null); // ドラッグ開始でツールチップを消す
    const dsx = sx - d.startSx;
    const dsy = sy - d.startSy;

    const orig = d.orig;
    if (d.kind === "pan" && "tx" in orig) {
      setView((v) => ({ ...v, tx: orig.tx + dsx, ty: orig.ty + dsy }));
    } else if (d.kind === "array" && d.arrId && "px" in orig) {
      // 画面移動量を画像座標の移動量へ（回転とズームを戻す）
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const idx = (cos * dsx + sin * dsy) / view.zoom;
      const idy = (-sin * dsx + cos * dsy) / view.zoom;
      patchContinuous("drag", {
        arrays: layout.arrays.map((a) =>
          a.id === d.arrId
            ? { ...a, posXpx: orig.px + idx, posYpx: orig.py + idy }
            : a
        ),
      });
    } else if (d.kind === "free" && d.freeId && "px" in orig) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const idx = (cos * dsx + sin * dsy) / view.zoom;
      const idy = (-sin * dsx + cos * dsy) / view.zoom;
      patchContinuous("drag", {
        freePanels: (layout.freePanels ?? []).map((f) =>
          f.id === d.freeId
            ? { ...f, posXpx: orig.px + idx, posYpx: orig.py + idy }
            : f
        ),
      });
    }
  }

  function onMouseUp() {
    dragRef.current = null;
    gestureRef.current = null; // ドラッグ終了。次のドラッグは別の履歴として積む
    // エリア選択の確定：囲んだ範囲をセル集合に変換して保持
    if (areaDragRef.current && scanStartRef.current) {
      areaDragRef.current = false;
      scanStartRef.current = null;
      if (scanDraft && scanDraft.w > 4 && scanDraft.h > 4) {
        const map = cellsInScreenRect(scanDraft);
        if (map.size) {
          const obj: Record<string, string[]> = {};
          for (const [id, keys] of map) obj[id] = [...keys];
          setSelection(obj);
          setSelPanelId("");
        } else {
          setSelection(null);
        }
      }
      setScanDraft(null);
      if (mode === "areaselect") setMode("pan"); // 選択できたら通常操作へ（再選択は Shift＋ドラッグ）
      return;
    }
    // 影ゾーンの確定
    if (mode === "shadow" && shadowStartRef.current) {
      shadowStartRef.current = null;
      if (shadowDraft && shadowDraft.w > 4 && shadowDraft.h > 4) {
        const zone: ShadowZone = { ...shadowDraft, id: uid("shadow") };
        patch({ shadowZones: [...(layout.shadowZones ?? []), zone] });
      }
      setShadowDraft(null);
    }
    // スキャン／範囲流用／範囲撤去／範囲欠け：画面で囲んだ範囲を確定
    if ((mode === "scan" || mode === "keeprect" || mode === "removerect" || mode === "missrect") && scanStartRef.current) {
      scanStartRef.current = null;
      if (scanDraft && scanDraft.w > 4 && scanDraft.h > 4) {
        if (mode === "scan") scanFromScreenRect(scanDraft);
        else if (mode === "keeprect") applyKeepRect(scanDraft, keepRectValue);
        else if (mode === "missrect") applyMissingRect(scanDraft, missRectValue);
        else applyRemoveRect(scanDraft, removeRectValue);
      }
      setScanDraft(null);
      // 右クリックメニュー経由の範囲指定は1回で完了し、続けてドラッグ移動できるようにする
      if (rectOnceRef.current) {
        rectOnceRef.current = false;
        setMode("pan");
      }
    }
  }

  /**
   * 画面で囲んだ範囲内のセルをまとめて撤去/復活する。
   * value=true で撤去（空き枠）、false で復活。不定形・三角の削り出しに使う。
   */
  function applyRemoveRect(r: { x: number; y: number; w: number; h: number }, value: boolean) {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    const arrays = layout.arrays.map((arr) => {
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      const a = (arr.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const removed = new Set(arr.removedCells ?? []);
      const missingSet = new Set(arr.missingCells ?? []);
      for (let row = 0; row < arr.rows; row++) {
        for (let col = 0; col < arr.cols; col++) {
          const k = cellKey(row, col);
          if (missingSet.has(k)) continue; // 欠け（パネル無し）は撤去対象外
          const lx = col * (pw + gapXpx) + pw / 2;
          const ly = row * (ph + gapYpx) + ph / 2;
          const ix = arr.posXpx + cos * lx - sin * ly;
          const iy = arr.posYpx + sin * lx + cos * ly;
          const s = imageToScreen(ix, iy);
          if (s.x >= r.x && s.x <= x2 && s.y >= r.y && s.y <= y2) {
            if (value) removed.add(k);
            else removed.delete(k);
          }
        }
      }
      return { ...arr, removedCells: [...removed] };
    });
    patch({ arrays });
  }

  /**
   * 画面で囲んだ矩形に中心が入るセルを、配列ごとに集める（欠けセルは除外）。
   * エリア選択・範囲操作の共通幾何計算。
   */
  function cellsInScreenRect(r: { x: number; y: number; w: number; h: number }): Map<string, Set<string>> {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    const out = new Map<string, Set<string>>();
    for (const arr of layout.arrays) {
      // ①既設の設定では新設（非表示）を選択対象にしない
      if (phase === "kisetsu" && arr.keepCells === undefined) continue;
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      const a = (arr.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const missing = new Set(arr.missingCells ?? []);
      const keys = new Set<string>();
      for (let row = 0; row < arr.rows; row++) {
        for (let col = 0; col < arr.cols; col++) {
          const k = cellKey(row, col);
          if (missing.has(k)) continue;
          const lx = col * (pw + gapXpx) + pw / 2;
          const ly = row * (ph + gapYpx) + ph / 2;
          const ix = arr.posXpx + cos * lx - sin * ly;
          const iy = arr.posYpx + sin * lx + cos * ly;
          const s = imageToScreen(ix, iy);
          if (s.x >= r.x && s.x <= x2 && s.y >= r.y && s.y <= y2) keys.add(k);
        }
      }
      if (keys.size) out.set(arr.id, keys);
    }
    return out;
  }

  /**
   * 画面で囲んだ範囲のセルをまとめて欠け（最初からパネルが無い）にする/戻す。
   * L字・へこみ等の不定形の削り出し用。欠けにしたセルはマークも掃除し、
   * 戻したセルは既設配列なら流用に戻す（入換扱いで撤去に数えられないように）。
   */
  function applyMissingRect(r: { x: number; y: number; w: number; h: number }, value: boolean) {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    const arrays = layout.arrays.map((arr) => {
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      const a = (arr.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const missing = new Set(arr.missingCells ?? []);
      const keep = arr.keepCells ? new Set(arr.keepCells) : null;
      const removed = new Set(arr.removedCells ?? []);
      for (let row = 0; row < arr.rows; row++) {
        for (let col = 0; col < arr.cols; col++) {
          const lx = col * (pw + gapXpx) + pw / 2;
          const ly = row * (ph + gapYpx) + ph / 2;
          const ix = arr.posXpx + cos * lx - sin * ly;
          const iy = arr.posYpx + sin * lx + cos * ly;
          const s = imageToScreen(ix, iy);
          if (s.x >= r.x && s.x <= x2 && s.y >= r.y && s.y <= y2) {
            const k = cellKey(row, col);
            if (value) {
              missing.add(k);
              keep?.delete(k);
              removed.delete(k);
            } else if (missing.has(k)) {
              missing.delete(k);
              keep?.add(k); // 復活したセルは既設なら流用スタート
            }
          }
        }
      }
      return {
        ...arr,
        missingCells: missing.size ? [...missing] : undefined,
        keepCells: keep ? [...keep] : undefined,
        removedCells: arr.removedCells ? [...removed] : undefined,
      };
    });
    patch({ arrays });
  }

  /** セル1つの欠け（最初からパネルが無い）を切り替える。 */
  function toggleMissing(arr: PanelArray, r: number, col: number) {
    const key = cellKey(r, col);
    const missing = new Set(arr.missingCells ?? []);
    const keep = arr.keepCells ? new Set(arr.keepCells) : null;
    const removed = new Set(arr.removedCells ?? []);
    if (missing.has(key)) {
      missing.delete(key);
      keep?.add(key); // 復活したセルは既設なら流用スタート
    } else {
      missing.add(key);
      keep?.delete(key);
      removed.delete(key);
    }
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id
          ? {
              ...a,
              missingCells: missing.size ? [...missing] : undefined,
              keepCells: keep ? [...keep] : undefined,
              removedCells: a.removedCells ? [...removed] : undefined,
            }
          : a
      ),
    });
  }

  /**
   * 画面で囲んだ範囲内のセルをまとめて流用/入換にする。
   * value=true：流用（緑・変更しない）に戻す＝入換も撤去もまとめて解除（取り消し機能）。
   * value=false：入換にする（撤去セルはそのまま）。
   */
  function applyKeepRect(r: { x: number; y: number; w: number; h: number }, value: boolean) {
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    const arrays = layout.arrays.map((arr) => {
      // 流用/入換マークは既設配列（マーク定義済み）のみ。新設配列を巻き込んで既設化しない
      if (arr.keepCells === undefined) return arr;
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapXpx, gapYpx } = dims;
      const a = (arr.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const keep = new Set(arr.keepCells ?? []);
      const removed = new Set(arr.removedCells ?? []);
      const missing = new Set(arr.missingCells ?? []);
      for (let row = 0; row < arr.rows; row++) {
        for (let col = 0; col < arr.cols; col++) {
          const k = cellKey(row, col);
          if (missing.has(k)) continue;
          if (!value && removed.has(k)) continue; // 入換指定は撤去セルを触らない
          // セル中心の画像座標（配列の回転を反映）→ 画面座標
          const lx = col * (pw + gapXpx) + pw / 2;
          const ly = row * (ph + gapYpx) + ph / 2;
          const ix = arr.posXpx + cos * lx - sin * ly;
          const iy = arr.posYpx + sin * lx + cos * ly;
          const s = imageToScreen(ix, iy);
          if (s.x >= r.x && s.x <= x2 && s.y >= r.y && s.y <= y2) {
            if (value) {
              keep.add(k);
              removed.delete(k); // 流用に戻す＝撤去も解除
            } else {
              keep.delete(k);
            }
          }
        }
      }
      return { ...arr, keepCells: [...keep], removedCells: arr.removedCells ? [...removed] : undefined };
    });
    patch({ arrays });
  }

  /**
   * 画面（スクリーン）で囲んだ矩形から、実寸÷パネル寸法で行×列を自動計算し配列を生成。
   * 生成する配列は画面の見た目に沿わせる（rotationDeg = -画像回転）ので、
   * 「写真を回してパネル列を水平にする → スキャン」で実パネルにグリッドが一致する。
   * スケール校正が前提（地理院地図なら自動設定済み）。
   */
  function scanFromScreenRect(r: { x: number; y: number; w: number; h: number }) {
    if (!formPanelId) {
      alert("先に下の「パネル」を選択してください");
      return;
    }
    if (!layout.calibration) {
      alert("スケール未設定です。地理院地図の取得か、基準寸法の設定を先に行ってください");
      return;
    }
    const panel = panels.find((p) => p.id === formPanelId);
    if (!panel) return;
    const lenM = panel.lengthMm / 1000;
    const widM = panel.widthMm / 1000;
    const pwM = formOrient === "portrait" ? widM : lenM; // 1枚の横幅(m)
    const phM = formOrient === "portrait" ? lenM : widM; // 1枚の高さ(m)
    if (pwM <= 0 || phM <= 0) {
      alert("選択したパネルの寸法が未登録です");
      return;
    }
    // 画面px → メートル（zoom: 画面px/画像px、pixelsPerMeter: 画像px/m）
    const mPerScreenPx = 1 / (view.zoom * pixelsPerMeter);
    const realW = r.w * mPerScreenPx;
    const realH = r.h * mPerScreenPx;
    const cols = Math.max(1, Math.floor((realW + formGapX) / (pwM + formGapX)));
    const rows = Math.max(1, Math.floor((realH + formGapY) / (phM + formGapY)));
    // 配列の原点（左上）は画面矩形の左上に対応する画像座標
    const tl = screenToImage(r.x, r.y);
    // 画面で水平に見えるよう、画像回転を打ち消す角度を配列に持たせる
    const arrRot = normalizeDeg(-layout.imageRotationDeg);
    const arr: PanelArray = {
      id: uid("arr"),
      panelId: formPanelId,
      orientation: formOrient,
      rows,
      cols,
      gapM: formGapX,
      gapYm: formGapY,
      posXpx: tl.x,
      posYpx: tl.y,
      rotationDeg: arrRot,
      color: ARRAY_COLORS[layout.arrays.length % ARRAY_COLORS.length],
      // ①で作った配列＝既設（全セル流用スタート）。②で追加＝新設（マーク無し）
      ...(phase === "kisetsu" ? { keepCells: allCellKeys(rows, cols) } : {}),
    };
    patch({ arrays: [...layout.arrays, arr] });
    setSelectedId(arr.id);
  }

  // ホイールズーム：React の onWheel は passive 登録で preventDefault が効かず
  // ページがスクロールしてしまうため、ネイティブの非passiveリスナーで実装する。
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault(); // ページスクロールを止める
      const rect = c.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((v) => {
        const nz = Math.max(0.05, Math.min(8, v.zoom * factor));
        // カーソル位置を固定してズーム
        const tx = sx - (sx - v.tx) * (nz / v.zoom);
        const ty = sy - (sy - v.ty) * (nz / v.zoom);
        return { tx, ty, zoom: nz };
      });
    };
    c.addEventListener("wheel", handler, { passive: false });
    return () => c.removeEventListener("wheel", handler);
  }, [layout.imageDataUrl]); // キャンバスがマウントされた後に確実に貼る

  /** ＋/− ボタン用：キャンバス中心を固定して拡大縮小 */
  function zoomByCentered(factor: number) {
    const c = canvasRef.current;
    if (!c) return;
    const sx = c.width / 2;
    const sy = c.height / 2;
    setView((v) => {
      const nz = Math.max(0.05, Math.min(8, v.zoom * factor));
      const tx = sx - (sx - v.tx) * (nz / v.zoom);
      const ty = sy - (sy - v.ty) * (nz / v.zoom);
      return { tx, ty, zoom: nz };
    });
  }

  // --- 操作ハンドラ ---
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!confirmSharedChange()) {
      e.target.value = "";
      return;
    }
    try {
      const url = await fileToScaledDataUrl(file);
      patch({ imageDataUrl: url, calibration: null, arrays: [] });
    } catch {
      alert("画像の読み込みに失敗しました");
    }
    e.target.value = "";
  }

  /** 住所を地理院ジオコーディング→航空写真を取得し、背景＋スケールを自動設定 */
  async function loadFromAddress() {
    const q = address.trim();
    if (!q) {
      setGsiMsg("住所を入力してください");
      return;
    }
    if (!confirmSharedChange()) return;
    setGsiBusy(true);
    setGsiMsg("住所を検索中…");
    try {
      const geo = await geocodeAddress(q);
      if (!geo) {
        setGsiMsg("住所が見つかりませんでした。表記を変えて再検索してください。");
        return;
      }
      setGsiMsg(`地図を取得中…（${geo.label}）`);
      const photo = await buildSeamlessPhoto(geo.lat, geo.lon, gsiZoom, gsiSpan);
      const cal = calibrationFromScale(photo.metersPerPixel, photo.heightPx, 50);
      // 既存の配置・影はクリア（新しい台紙のため）。校正は自動設定。
      patch({
        imageDataUrl: photo.dataUrl,
        calibration: cal,
        arrays: [],
        freePanels: [],
        shadowZones: [],
        imageRotationDeg: 0,
        imageOpacity: 1,
      });
      setGsiMsg(
        `取得完了：${geo.label}｜ズーム${photo.zoom}｜スケール ${(1 / photo.metersPerPixel).toFixed(1)} px/m（自動校正済み・出典:地理院タイル）`
      );
    } catch (err) {
      setGsiMsg(err instanceof Error ? err.message : "地図の取得に失敗しました");
    } finally {
      setGsiBusy(false);
    }
  }

  /**
   * 画像を回転する。画面中心にある画像上の点を軸に回す（view を補正）ので、
   * 拡大中でも見ている被写体が画面外へ飛ばない。
   */
  function setRotation(newDeg: number) {
    if (!confirmSharedChange()) return;
    const c = canvasRef.current;
    const deg = ((newDeg % 360) + 360) % 360;
    if (!c) {
      patchContinuous("imgrot", { imageRotationDeg: deg });
      return;
    }
    const Cx = c.width / 2;
    const Cy = c.height / 2;
    const rot0 = (layout.imageRotationDeg * Math.PI) / 180;
    const rot1 = (deg * Math.PI) / 180;
    // 現在、画面中心にある画像上の点 P0 を求める（screenToImage と同じ式）
    const a = (Cx - view.tx) / view.zoom;
    const b = (Cy - view.ty) / view.zoom;
    const p0x = Math.cos(rot0) * a + Math.sin(rot0) * b;
    const p0y = -Math.sin(rot0) * a + Math.cos(rot0) * b;
    // 新しい回転で P0 が画面中心に来るよう平行移動を補正
    const tx = Cx - view.zoom * (Math.cos(rot1) * p0x - Math.sin(rot1) * p0y);
    const ty = Cy - view.zoom * (Math.sin(rot1) * p0x + Math.cos(rot1) * p0y);
    setView((v) => ({ ...v, tx, ty }));
    patchContinuous("imgrot", { imageRotationDeg: deg });
  }

  function rotate(delta: number) {
    setRotation(layout.imageRotationDeg + delta);
  }

  function exportPng() {
    const c = canvasRef.current;
    if (!c) return;
    draw(); // 最新状態で描画してから書き出し
    const url = c.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `layout_${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  }

  /** 結線図（写真＝キャンバス部分だけ）を別ウィンドウでPDF印刷する。 */
  function exportCanvasPdf() {
    const c = canvasRef.current;
    if (!c) return;
    draw();
    const url = c.toDataURL("image/png");
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
    const pcsRows = wiring
      ? wiring.perPcs
          .map(
            (p) =>
              `<span style="display:inline-flex;align-items:center;margin:0 12px 4px 0"><span style="width:12px;height:12px;background:${p.color};border-radius:2px;margin-right:5px"></span>PC${p.pcsNo}：${p.panels}枚／${p.strings}str</span>`
          )
          .join("")
      : "";
    const legendRows = legend
      .map(
        (l) =>
          `<div style="margin:2px 0"><span style="display:inline-block;width:12px;height:12px;background:${l.color};border-radius:2px;margin-right:6px;vertical-align:middle"></span>${esc(l.label)}</div>`
      )
      .join("");
    const w = window.open("", "_blank");
    if (!w) {
      alert("ポップアップがブロックされました。許可してから再実行してください。");
      return;
    }
    w.document.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>結線図</title>
<style>@page{size:A4 landscape;margin:8mm} body{font-family:sans-serif;margin:0;padding:6mm;color:#0b1220}
img{width:100%;height:auto;border:1px solid #cbd5e1} .row{font-size:12px;margin-top:6px}</style></head>
<body><img src="${url}"/>
<div class="row">${pcsRows}</div>
<div class="row">${legendRows}</div>
<script>window.onload=function(){setTimeout(function(){window.print();},350);};</script>
</body></html>`
    );
    w.document.close();
  }

  function clearWiringOverrides() {
    if (!layout.wiringOverrides || Object.keys(layout.wiringOverrides).length === 0) return;
    if (!confirm("結線の手編集をすべて消して自動割付に戻します。よろしいですか？")) return;
    setWiringOverrides({});
  }

  /** 工事説明書PDF：表紙＋現在の図面＋完成後(結線図)＋パワコン構成 を1つの印刷用に出す。 */
  async function exportConstructionPdf() {
    const c = canvasRef.current;
    if (!c) {
      alert("先に住所から地図を取得するか写真をアップロードしてください。");
      return;
    }
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]!));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const origWire = wireMode;
    // 現在の図面（結線オフ）
    setWireMode(false);
    await sleep(220);
    const imgLayout = c.toDataURL("image/jpeg", 0.9);
    // 完成後＝結線図（結線オン）
    setWireMode(true);
    await sleep(300);
    const imgWiring = c.toDataURL("image/jpeg", 0.9);
    setWireMode(origWire);

    // 集計
    const base = layout.baseline;
    const after = summarizeLayout(layout, panels, "kaishu");
    const fmt = (n: number) => n.toLocaleString();
    const kw = (n: number) => n.toFixed(1);

    // パワコン構成表
    const units = pcsUnits ?? [];
    let pcsRows = "";
    let totalAc = 0;
    let no = 0;
    for (const u of units) {
      const pcs = pcsList?.find((p) => p.id === u.pcsId);
      const ac = pcs?.ratedPowerKw ?? 0;
      for (let i = 0; i < u.count; i++) {
        no++;
        totalAc += ac;
        const str = (u.strings ?? [])
          .map((s) => {
            const pn = panels.find((p) => p.id === s.panelId);
            return `${pn ? pn.model : "—"}×${s.series}直${s.parallel > 1 ? `×${s.parallel}並` : ""}`;
          })
          .join("、");
        const pcsName = pcs ? `${pcs.maker} ${pcs.model}${pcs.warranty ? `（${pcs.warranty}）` : ""}` : "—";
        pcsRows += `<tr><td>#${no}</td><td>${esc(pcsName)}</td><td style="text-align:right">${ac.toFixed(2)}</td><td>${esc(str)}</td></tr>`;
      }
    }
    const baseRow = base
      ? `<tr><td>現状（改修前）</td><td style="text-align:right">${fmt(base.totalPanels)}</td><td style="text-align:right">${kw(base.totalKw)}</td></tr>`
      : "";
    const afterRow = `<tr><td>完成後（改修案）</td><td style="text-align:right">${fmt(after.totalPanels)}</td><td style="text-align:right">${kw(after.totalKw)}</td></tr>`;
    const legendHtml = legend
      .map((l) => `<span style="display:inline-flex;align-items:center;margin:0 10px 4px 0"><span style="width:11px;height:11px;background:${l.color};border-radius:2px;margin-right:4px"></span>${esc(l.label)}</span>`)
      .join("");
    const today = new Date().toISOString().slice(0, 10);

    const w = window.open("", "_blank");
    if (!w) {
      alert("ポップアップがブロックされました。許可してから再実行してください。");
      return;
    }
    w.document.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>工事説明書</title>
<style>
@page{size:A4 landscape;margin:10mm}
body{font-family:sans-serif;color:#0b1220;margin:0}
.page{page-break-after:always;padding:6mm}
.page:last-child{page-break-after:auto}
h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;border-bottom:2px solid #0b1220;padding-bottom:3px}
img{width:100%;height:auto;border:1px solid #cbd5e1;margin-top:6px}
table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
th,td{border:1px solid #cbd5e1;padding:4px 6px} th{background:#f1f5f9;text-align:left}
.meta{font-size:13px} .meta td{border:none;padding:2px 8px 2px 0}
.lg{font-size:11px;margin-top:6px}
</style></head><body>

<div class="page">
  <h1>太陽光発電設備 改修工事説明書</h1>
  <table class="meta">
    <tr><td>発電所</td><td>${esc(plantName ?? "—")}</td></tr>
    <tr><td>顧客名</td><td>${esc(customerName ?? "—")}</td></tr>
    <tr><td>作成日</td><td>${today}</td></tr>
  </table>
  <h2>工事概要</h2>
  <table>
    <tr><th>区分</th><th style="text-align:right">パネル枚数</th><th style="text-align:right">出力(kW)</th></tr>
    ${baseRow}${afterRow}
  </table>
  <table style="margin-top:8px">
    <tr><th>パワコン構成</th><th style="text-align:right">合計AC(kW)</th><th style="text-align:right">台数</th></tr>
    <tr><td>新設パワコン</td><td style="text-align:right">${totalAc.toFixed(2)}</td><td style="text-align:right">${no} 台</td></tr>
  </table>
</div>

<div class="page">
  <h2>① 現在の図面（改修前）</h2>
  <img src="${imgLayout}"/>
  <div class="lg">${legendHtml}</div>
</div>

<div class="page">
  <h2>② 完成後の図面（結線図・パワコン割付）</h2>
  <img src="${imgWiring}"/>
</div>

<div class="page">
  <h2>③ パワコン構成</h2>
  <table>
    <tr><th>#</th><th>機種</th><th style="text-align:right">AC(kW)</th><th>ストリング</th></tr>
    ${pcsRows || '<tr><td colspan="4">パワコン構成が未設定です。</td></tr>'}
    <tr><th colspan="2">合計</th><th style="text-align:right">${totalAc.toFixed(2)}</th><th>${no} 台</th></tr>
  </table>
</div>

<script>window.onload=function(){setTimeout(function(){window.print();},400);};</script>
</body></html>`
    );
    w.document.close();
  }

  function addArray() {
    if (!formPanelId) {
      alert("パネルを登録・選択してください");
      return;
    }
    const center = screenToImage(
      (canvasRef.current?.width ?? 600) / 2,
      (canvasRef.current?.height ?? 600) / 2
    );
    const arr: PanelArray = {
      id: uid("arr"),
      panelId: formPanelId,
      orientation: formOrient,
      rows: formRows,
      cols: formCols,
      gapM: formGapX,
      gapYm: formGapY,
      posXpx: center.x,
      posYpx: center.y,
      // 画面の見た目（回転後）に合わせる。スキャンのグリッドと同じ向きになる。
      rotationDeg: normalizeDeg(-layout.imageRotationDeg),
      color: ARRAY_COLORS[layout.arrays.length % ARRAY_COLORS.length],
      // ①で作った配列＝既設（全セル流用スタート）。②で追加＝新設（マーク無し）
      ...(phase === "kisetsu" ? { keepCells: allCellKeys(formRows, formCols) } : {}),
    };
    patch({ arrays: [...layout.arrays, arr] });
    setSelectedId(arr.id);
    // 挿入直後はドラッグで位置調整できるように編集モードを解除（撤去/入換モードのままだと動かせない）
    setMode("pan");
  }

  function updateArray(id: string, p: Partial<PanelArray>, gesture?: string) {
    const upd = { arrays: layout.arrays.map((a) => (a.id === id ? { ...a, ...p } : a)) };
    if (gesture) patchContinuous(gesture, upd);
    else patch(upd);
  }
  /**
   * 行数・列数の変更。1未満や小数を防ぎ、新しいグリッドの範囲外になった
   * 流用/撤去/型式上書きのマークを掃除する（残すと枚数集計や表示が狂う）。
   * keepCells の有無は既設/新設の判定に使うため、未定義の配列（新設）には生やさない。
   * 流用マークのある既設配列を拡大した場合は、増えたセルにも流用マークを付ける。
   */
  function resizeArray(id: string, p: { rows?: number; cols?: number }) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== id) return a;
        const rows = Math.max(1, Math.floor(p.rows ?? a.rows) || 1);
        const cols = Math.max(1, Math.floor(p.cols ?? a.cols) || 1);
        const ok = (k: string) => {
          const i = k.indexOf(",");
          const r = Number(k.slice(0, i));
          const c = Number(k.slice(i + 1));
          return r >= 0 && r < rows && c >= 0 && c < cols;
        };
        const cellPanels = a.cellPanels
          ? Object.fromEntries(Object.entries(a.cellPanels).filter(([k]) => ok(k)))
          : undefined;
        let keepCells = a.keepCells ? a.keepCells.filter(ok) : undefined;
        if (keepCells && a.keepCells!.length > 0) {
          // 流用マークのある既設配列：拡大で増えたセルも既設＝流用にする
          const set = new Set(keepCells);
          for (let r = 0; r < rows; r++)
            for (let c = 0; c < cols; c++)
              if (r >= a.rows || c >= a.cols) set.add(cellKey(r, c));
          keepCells = [...set];
        }
        return {
          ...a,
          rows,
          cols,
          keepCells,
          removedCells: a.removedCells ? a.removedCells.filter(ok) : undefined,
          missingCells: a.missingCells ? a.missingCells.filter(ok) : undefined,
          cellPanels,
        };
      }),
    });
  }
  function deleteArray(id: string) {
    const a = layout.arrays.find((x) => x.id === id);
    if (!a) return;
    // ②から既設区画を削除する場合は、既設＝全候補共通の実体が消えることを確認してから実行する
    if (phase === "henkou" && a.keepCells !== undefined) {
      if (
        !confirm(
          `この区画（${a.rows}行×${a.cols}列）は既設です。削除すると既設の図面（全候補共通）から消えます。\n` +
            "この候補だけで外したい場合はキャンセルして「撤去」を使ってください。\n" +
            "既設ごと削除しますか？（「戻す」で復元可）"
        )
      )
        return;
      patch({ arrays: layout.arrays.filter((x) => x.id !== id) });
      if (selectedId === id) setSelectedId(null);
      return;
    }
    if (!confirm(`この区画（${a.rows}行×${a.cols}列）を削除しますか？（「戻す」で復元可）`)) return;
    patch({ arrays: layout.arrays.filter((x) => x.id !== id) });
    if (selectedId === id) setSelectedId(null);
  }

  /** 単独パネル（free panel）だけを全消去。Undoで戻せる。 */
  function clearFreePanels() {
    if ((layout.freePanels?.length ?? 0) === 0) return;
    if (!confirm(`単独パネル ${layout.freePanels?.length ?? 0} 枚をすべて消去します。よろしいですか？（「戻す」で復元可）`)) return;
    patch({ freePanels: [] });
    setSelectedFreeId(null);
  }

  /** 配置した配列・単独パネル（＝画面上のグリッド線）を全消去。Undoで戻せる。
   *  ②では既設（流用マーク定義済み）の区画は守り、新設の配列・単独パネルだけを消す。 */
  function clearAllArrays() {
    if (layout.arrays.length === 0 && (layout.freePanels?.length ?? 0) === 0) return;
    if (phase === "henkou") {
      const kept = layout.arrays.filter((a) => a.keepCells !== undefined);
      const delCount = layout.arrays.length - kept.length + (layout.freePanels?.length ?? 0);
      if (delCount === 0) {
        alert("②で消去できるのは新設の配列・単独パネルだけです（既設の図面は「① 既設の設定」で）。");
        return;
      }
      if (!confirm(`新設の配列・単独パネル（計${delCount}件）を消去します。既設はそのまま残ります。よろしいですか？（「戻す」で復元可）`)) return;
      patch({ arrays: kept, freePanels: [] });
    } else {
      // ①では既設（マーク定義済み）だけを消す。②の新設配列・単独パネルは候補の検討内容なので残す
      const keptNew = layout.arrays.filter((a) => a.keepCells === undefined);
      const delCount = layout.arrays.length - keptNew.length;
      if (delCount === 0) {
        alert("消去できる既設の配列がありません。");
        return;
      }
      if (!confirm(`既設の配列（${delCount}件）をすべて消去します。よろしいですか？（「戻す」で復元可）`)) return;
      patch({ arrays: keptNew });
    }
    setSelectedId(null);
    setSelectedFreeId(null);
  }

  function addFreePanel() {
    if (!formPanelId) {
      alert("パネルを登録・選択してください");
      return;
    }
    const center = screenToImage(
      (canvasRef.current?.width ?? 600) / 2,
      (canvasRef.current?.height ?? 600) / 2
    );
    const fp: FreePanel = {
      id: uid("free"),
      panelId: formPanelId,
      orientation: formOrient,
      posXpx: center.x,
      posYpx: center.y,
      // 画面の見た目（回転後）に合わせる
      rotationDeg: normalizeDeg(-layout.imageRotationDeg),
      color: "#f472b6",
    };
    patch({ freePanels: [...(layout.freePanels ?? []), fp] });
    setSelectedFreeId(fp.id);
    setSelectedId(null);
    // 挿入直後はドラッグで位置調整できるように編集モードを解除
    setMode("pan");
  }
  function updateFree(id: string, p: Partial<FreePanel>, gesture?: string) {
    const upd = { freePanels: (layout.freePanels ?? []).map((f) => (f.id === id ? { ...f, ...p } : f)) };
    if (gesture) patchContinuous(gesture, upd);
    else patch(upd);
  }
  function deleteFree(id: string) {
    patch({ freePanels: (layout.freePanels ?? []).filter((f) => f.id !== id) });
    if (selectedFreeId === id) setSelectedFreeId(null);
  }

  const selected = layout.arrays.find((a) => a.id === selectedId) ?? null;
  const selectedFree = (layout.freePanels ?? []).find((f) => f.id === selectedFreeId) ?? null;
  const freeCount = (layout.freePanels ?? []).length;
  // 範囲外の死にキー・流用∩撤去の重複を除いた実数で集計（layoutCount と同一ルール）
  const cellStats = layout.arrays.map((a) => arrayCellStats(a));
  const removedTotal = cellStats.reduce((s, x) => s + x.removed, 0);
  const arrayCells = cellStats.reduce((s, x) => s + x.grid, 0);
  const totalPanels = arrayCells - removedTotal + freeCount;
  const keepTotal = cellStats.reduce((s, x) => s + x.keep, 0);
  // ①既設の設定ビュー用：既設（マーク定義済み）の満数と、非表示にしている新設の数
  const existingTotal = cellStats.reduce((s, x) => s + (x.marked ? x.grid : 0), 0);
  const hiddenNewArrays = cellStats.filter((x) => !x.marked).length;
  const zones = layout.shadowZones ?? [];
  const shadedTotal = layout.arrays.reduce(
    (s, a) => s + shadedCellKeys(a, arrayPanelPx(a), zones).size,
    0
  );

  function deleteZone(id: string) {
    patch({ shadowZones: zones.filter((z) => z.id !== id) });
  }
  function clearZones() {
    patch({ shadowZones: [] });
  }

  /** いまの構成を「現状（基準）」として凍結保存する（現況＝既存配列の全数）。 */
  function registerBaseline() {
    // 流用マークのある配列＝既存。無ければ図面の全パネルを現状として登録する。
    let sum = summarizeLayout(layout, panels, "genkyo");
    if (sum.totalPanels === 0) sum = summarizeLayout(layout, panels, "kaishu");
    if (sum.totalPanels === 0) {
      alert("配置がありません。図面にパネルを置くか、下の「現状を手入力」で入力してください。");
      return;
    }
    if (
      layout.baseline &&
      !confirm("すでに基準が登録されています。今の構成で上書きしますか？")
    )
      return;
    // 数値と一緒に「既設図面の凍結コピー」も保存する＝本当の固定（壊れたら登録時点に戻せる）
    patch({ baseline: { ...sum, registeredAt: Date.now(), arrays: snapshotExisting() } });
    setManualMsg(`✓ 現状を基準として登録しました（${sum.totalPanels.toLocaleString()}枚・${sum.totalKw.toFixed(1)}kW・図面も凍結保存）`);
  }

  /** 作業コピーから既設（マーク定義済み）だけを、マーク無しの実体で取り出す。
   *  欠け（形）とセルごとの型式（混在の塗り分け）は実体の一部なので含める。 */
  function snapshotExisting(): PanelArray[] {
    return layout.arrays
      .filter((a) => a.keepCells !== undefined)
      .map((a) => {
        const body: PanelArray = JSON.parse(JSON.stringify(a));
        delete body.keepCells;
        delete body.removedCells;
        return body;
      });
  }

  /** 既設の図面を「基準登録した時点」に戻す。既設マスタごと書き換えるため全候補に反映される。 */
  function restoreExistingFromBaseline() {
    const snap = layout.baseline?.arrays;
    if (!snap?.length) return;
    if (
      !confirm(
        "既設の図面を「現状を基準登録」した時点に戻します。\n" +
          "①の既設（形・欠け・配置・型式）が登録時点に戻り、全候補に反映されます。\n" +
          "②の新設・撤去マークはそのまま残ります（この候補の流用指定は全部流用に戻ります）。\n" +
          "よろしいですか？（「戻す」で取り消せます）"
      )
    )
      return;
    const snapCopy: PanelArray[] = JSON.parse(JSON.stringify(snap));
    const restored = snapCopy.map((a) => ({ ...a, keepCells: allCellKeys(a.rows, a.cols) }));
    const news = layout.arrays.filter((a) => a.keepCells === undefined);
    patch({ arrays: [...restored, ...news], existingArrays: snapCopy });
  }

  function clearBaseline() {
    if (!confirm("登録した基準を削除します。よろしいですか？（戻すで復元可）")) return;
    patch({ baseline: null });
  }

  // --- 凡例（写真の下の状況説明） ---
  const legend = layout.legend ?? [];
  /** 図面から凡例を自動生成（流用＝既設・緑／入換・新規＝新設・青、型式ごと）。 */
  function genLegend() {
    const map = new Map<string, { existing: number; added: number; orient: string; name: string; w: number }>();
    const touch = (panelId: string, orient: string) => {
      const p = panels.find((x) => x.id === panelId);
      const key = panelId;
      const cur = map.get(key) ?? {
        existing: 0,
        added: 0,
        orient,
        name: `${p?.maker ?? ""} ${p?.model ?? ""}`.trim() || "未登録パネル",
        w: p?.pmaxW ?? 0,
      };
      map.set(key, cur);
      return cur;
    };
    // 配列単位で判定：流用マークあり＝既設（流用数）／無し＝新設（全数）。
    // 既存配列の入換セル（流用でない分）は撤去されるため凡例には出さない。
    for (const a of layout.arrays) {
      const s = arrayCellStats(a);
      const cur = touch(a.panelId, a.orientation === "portrait" ? "縦" : "横");
      if (s.hasKeep) cur.existing += s.keep;
      else cur.added += s.grid - s.removed;
    }
    for (const f of layout.freePanels ?? []) {
      const cur = touch(f.panelId, f.orientation === "portrait" ? "縦" : "横");
      cur.added++;
    }
    const items: LegendItem[] = [];
    for (const v of map.values()) {
      if (v.existing > 0)
        items.push({ id: uid("lg"), color: KEEP_COLOR, label: `${v.name} ${v.w}W ${v.existing}枚 既設 ${v.orient}` });
      if (v.added > 0)
        items.push({ id: uid("lg"), color: "#38bdf8", label: `${v.name} ${v.w}W ${v.added}枚 新設 ${v.orient}` });
    }
    if (items.length === 0) {
      alert("配列がありません。先にパネルを配置してください。");
      return;
    }
    patch({ legend: items });
  }
  function addLegend() {
    patch({ legend: [...legend, { id: uid("lg"), color: "#22c55e", label: "" }] });
  }
  function updateLegend(id: string, p: Partial<LegendItem>) {
    patch({ legend: legend.map((l) => (l.id === id ? { ...l, ...p } : l)) });
  }
  function removeLegend(id: string) {
    patch({ legend: legend.filter((l) => l.id !== id) });
  }

  // --- 現状の手入力（レイアウト不要・複雑な発電所向け） ---
  const manualCurrent = layout.manualCurrent ?? [];
  function addManualLine() {
    setManualMsg(null);
    patch({ manualCurrent: [...manualCurrent, { id: uid("mc"), panelId: panels[0]?.id ?? "", count: 0 }] });
  }
  function updateManualLine(id: string, p: Partial<{ panelId: string; count: number }>) {
    setManualMsg(null);
    patch({ manualCurrent: manualCurrent.map((m) => (m.id === id ? { ...m, ...p } : m)) });
  }
  function removeManualLine(id: string) {
    setManualMsg(null);
    patch({ manualCurrent: manualCurrent.filter((m) => m.id !== id) });
  }
  /** 手入力の現状を「基準（現況）」として登録する。 */
  function registerBaselineFromManual() {
    const byModel = new Map<string, { count: number; kw: number }>();
    for (const m of manualCurrent) {
      if (m.count <= 0) continue;
      const p = panels.find((x) => x.id === m.panelId);
      const model = p ? `${p.maker} ${p.model}` : "未登録パネル";
      const kw = (m.count * (p?.pmaxW ?? 0)) / 1000;
      const cur = byModel.get(model) ?? { count: 0, kw: 0 };
      byModel.set(model, { count: cur.count + m.count, kw: cur.kw + kw });
    }
    const byPanel = [...byModel.entries()].map(([model, v]) => ({ model, count: v.count, kw: v.kw }));
    const totalPanels = byPanel.reduce((s, b) => s + b.count, 0);
    if (totalPanels === 0) {
      alert("枚数を入力してください。");
      return;
    }
    const totalKw = byPanel.reduce((s, b) => s + b.kw, 0);
    if (layout.baseline && !confirm("既に基準が登録されています。手入力の内容で上書きしますか？")) return;
    patch({ baseline: { totalPanels, totalKw, byPanel, registeredAt: Date.now() } });
    setManualMsg(`✓ 現状を基準として登録しました（${totalPanels.toLocaleString()}枚・${totalKw.toFixed(1)}kW）`);
  }
  const manualTotal = manualCurrent.reduce((s, m) => s + (m.count || 0), 0);
  const manualKw = manualCurrent.reduce((s, m) => {
    const p = panels.find((x) => x.id === m.panelId);
    return s + ((m.count || 0) * (p?.pmaxW ?? 0)) / 1000;
  }, 0);

  function setAllPlant(keepAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        // 既設配列（マーク定義済み）のみ対象。②で追加した新設配列の区分は変えない
        if (a.keepCells === undefined) return a;
        // 全部を流用＝完全な取り消し（撤去マークも解除）。全部を入換は撤去マークを保持
        return keepAll
          ? { ...a, keepCells: allCellKeys(a.rows, a.cols), removedCells: undefined }
          : { ...a, keepCells: [] };
      }),
    });
  }

  return (
    <>
      {/* 作業フェーズの切替：既設づくりと変更検討を混ぜない */}
      <div className="phase-switch no-print">
        <button className={phase === "kisetsu" ? "active" : ""} onClick={() => switchPhase("kisetsu")}>
          ① 既設の設定
          <small>地図取得・スキャン・現況図面</small>
        </button>
        <button className={phase === "henkou" ? "active" : ""} onClick={() => switchPhase("henkou")}>
          ② 変更の検討
          <small>流用/入換・撤去・結線図・前後比較</small>
        </button>
        <span className="hint" style={{ flex: 1 }}>
          {phase === "kisetsu"
            ? "まず既設（現況）の図面を作り、「現状を基準登録」したら ② へ。"
            : "既設図面の上で入換・撤去を指定し、結線図・前後比較・PDFを作ります。"}
        </span>
      </div>

      {phase === "kisetsu" && (
      <div className="card">
        <h2>既設の設定（現況図面づくり）</h2>
        {hasCandidates && (
          <div className="hint" style={{ color: "#fbbf24", marginBottom: 8 }}>
            ⚠ 検討候補{candidateCount ? `（${candidateCount}件）` : ""}があります。
            ここで地図・写真・校正・向きを変更すると<strong>全ての候補が削除されます</strong>（変更前に確認が出ます）。
            <br />候補ごとのパネル配置・撤去/入換は「② 変更の検討」で編集できます。
          </div>
        )}

        <h3>住所から地図を取得（地理院タイル）</h3>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label>住所</label>
            <input
              type="text"
              value={address}
              placeholder="例）愛知県西尾市吉良町吉田西川畔"
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !gsiBusy) loadFromAddress(); }}
            />
          </div>
          <div className="field" style={{ width: 120 }}>
            <label>詳細さ（ズーム）</label>
            <select value={gsiZoom} onChange={(e) => setGsiZoom(Number(e.target.value))}>
              <option value={16}>16（広い・粗い）</option>
              <option value={17}>17</option>
              <option value={18}>18（最も詳細）</option>
            </select>
          </div>
          <div className="field" style={{ width: 130 }}>
            <label>範囲・一辺(m)</label>
            <input
              type="number"
              min={50}
              step={50}
              value={gsiSpan}
              onChange={(e) => setGsiSpan(Number(e.target.value))}
            />
          </div>
          <button className="btn small" onClick={loadFromAddress} disabled={gsiBusy}>
            {gsiBusy ? "取得中…" : "地図を取得"}
          </button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          住所→航空写真を自動取得。<strong>スケールも自動設定</strong>されるので基準寸法の手入力は不要です。
          範囲を広げると視野が広く・詳細さは粗くなります。出典：地理院タイル（国土地理院）。
          {gsiMsg && (
            <div style={{ marginTop: 4, color: "#38bdf8" }}>{gsiMsg}</div>
          )}
        </div>

        {/* 通常は住所→地図取得で足りるため、アップロードと手動校正は折りたたみに収納 */}
        <details className="fold">
          <summary>写真をアップロードして使う（航空写真が古い・粗いとき用）</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="btn secondary small" style={{ cursor: "pointer" }}>
              写真をアップロード
              <input type="file" accept="image/*" onChange={onUpload} style={{ display: "none" }} />
            </label>
            <span className="hint">
              アップロードした写真は縮尺が不明なため、下の「基準寸法を設定」で校正してください（地図取得なら自動）。
            </span>
          </div>
          {layout.imageDataUrl && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className={`btn small ${mode === "calibrate" ? "" : "secondary"}`}
                onClick={() => {
                  if (mode !== "calibrate" && !confirmSharedChange()) return;
                  setMode(mode === "calibrate" ? "pan" : "calibrate");
                  setCalibPts([]);
                }}
              >
                {mode === "calibrate" ? "基準線：2点をクリック中…" : "基準寸法を設定"}
              </button>
              {layout.calibration && (
                <button className="btn secondary small" onClick={() => { if (confirmSharedChange()) patch({ calibration: null }); }}>
                  校正クリア
                </button>
              )}
              <span className="hint">
                既知の長さ（パネル1枚の実寸や敷地の一辺）の両端をクリック→実長(m)を入力
              </span>
            </div>
          )}
        </details>

        {layout.imageDataUrl && (
          <div className="row" style={{ marginTop: 8 }}>
            {imgReady && (
              <button className="btn secondary small" onClick={() => imgRef.current && fitToView(imgRef.current)}>
                全体表示
              </button>
            )}
            <button className="btn secondary small" onClick={exportPng}>
              図面をPNG保存
            </button>
            <span className="spacer" />
            <span className="hint">
              {layout.calibration
                ? `スケール: ${pixelsPerMeter.toFixed(1)} px/m`
                : "未校正（基準寸法を設定してください）"}
              {phase === "kisetsu"
                ? ` ／ 既設 合計 ${existingTotal} 枚${hiddenNewArrays || freeCount ? `（②の変更内容＝新設${hiddenNewArrays}配列・単独${freeCount}枚はここに表示しません）` : ""}`
                : ` ／ 合計 ${totalPanels} 枚（流用 ${keepTotal}${removedTotal ? ` / 撤去 ${removedTotal}` : ""}${freeCount ? ` / 追加 ${freeCount}` : ""}）`}
            </span>
          </div>
        )}

        {!layout.imageDataUrl && (
          <div className="empty">住所から地図を取得するか、写真をアップロードすると、ここに表示されます。</div>
        )}
      </div>
      )}

      {phase === "henkou" && !layout.imageDataUrl && (
        <div className="card">
          <div className="empty">先に「① 既設の設定」で図面（地図取得 または 写真）を作ってください。</div>
        </div>
      )}

      {/* 変更の検討：既設図面の上に流用/入換・撤去・影を重ねて指定する */}
      {phase === "henkou" && layout.imageDataUrl && (
        <div className="card">
          {candidateBar}
          <h2>変更の検討（流用・撤去・影）</h2>
          <>
            <h3>流用パネルの指定（変更しないパネル）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "select" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "select" ? "pan" : "select")}
              >
                {mode === "select" ? "選択中：パネルをクリックで切替" : "流用/入換を指定"}
              </button>
              <button
                className={`btn small ${mode === "keeprect" && keepRectValue ? "" : "secondary"}`}
                onClick={() => {
                  setKeepRectValue(true);
                  setMode(mode === "keeprect" && keepRectValue ? "pan" : "keeprect");
                }}
              >
                {mode === "keeprect" && keepRectValue ? "範囲を戻し中：ドラッグで囲む" : "▦ 範囲を戻す（流用へ・取り消し）"}
              </button>
              <button
                className={`btn small ${mode === "keeprect" && !keepRectValue ? "" : "secondary"}`}
                onClick={() => {
                  setKeepRectValue(false);
                  setMode(mode === "keeprect" && !keepRectValue ? "pan" : "keeprect");
                }}
              >
                {mode === "keeprect" && !keepRectValue ? "範囲入換中：ドラッグで囲む" : "▦ 範囲を入換（ドラッグ）"}
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(true)}>
                全部を流用
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(false)}>
                全部を入換
              </button>
              <span className="hint">
                <span style={{ color: KEEP_COLOR }}>■</span> 緑＝流用（変更しない）。既設は<strong>最初から全て流用</strong>なので、<strong>変える所（入換・撤去）だけ指定</strong>すればOK。<br />
                「▦ 範囲を戻す」は入換・撤去をまとめて流用に戻す取り消し用。指定はこの候補だけに保存されます（既設の図面そのものは全候補で共通）。
              </span>
            </div>

            <h3>パネルの撤去（フェンス離隔・不定形/三角の削り出し）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "remove" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "remove" ? "pan" : "remove")}
              >
                {mode === "remove" ? "撤去モード：クリックで撤去/復活" : "1枚ずつ撤去/復活"}
              </button>
              <button
                className={`btn small ${mode === "removerect" && removeRectValue ? "" : "secondary"}`}
                onClick={() => { setRemoveRectValue(true); setMode(mode === "removerect" && removeRectValue ? "pan" : "removerect"); }}
              >
                {mode === "removerect" && removeRectValue ? "範囲撤去中：ドラッグで囲む" : "▦ 範囲を撤去（ドラッグ）"}
              </button>
              <button
                className={`btn small ${mode === "removerect" && !removeRectValue ? "" : "secondary"}`}
                onClick={() => { setRemoveRectValue(false); setMode(mode === "removerect" && !removeRectValue ? "pan" : "removerect"); }}
              >
                {mode === "removerect" && !removeRectValue ? "範囲復活中：ドラッグで囲む" : "▦ 範囲を戻す（ドラッグ）"}
              </button>
              <span className="hint">
                クリックで1枚ずつ、または<strong>範囲ドラッグでまとめて</strong>撤去（破線の空き枠）。
                長方形を置いて要らない部分を範囲撤去すれば<strong>三角・L字・不定形</strong>が作れます。撤去分は枚数から除外。
              </span>
            </div>

            <h3>影ゾーン</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "shadow" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "shadow" ? "pan" : "shadow")}
              >
                {mode === "shadow" ? "描画中：ドラッグで影エリアを囲む" : "影ゾーンを描く"}
              </button>
              {zones.length > 0 && (
                <button className="btn secondary small" onClick={clearZones}>影を全消去</button>
              )}
              <span className="hint">
                影になる範囲をドラッグで囲むと、かかるパネルを暗く表示し枚数をカウント。
                合計 <strong>{shadedTotal}</strong> 枚が影。
              </span>
            </div>
            {zones.length > 0 && (
              <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
                {zones.map((z, i) => (
                  <span key={z.id} className="badge" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    影{i + 1}
                    <button className="btn danger small" style={{ padding: "0 6px" }} onClick={() => deleteZone(z.id)}>×</button>
                  </span>
                ))}
              </div>
            )}
          </>
        </div>
      )}

      {/* 現状を手入力で登録（レイアウト＝配列が無い複雑な発電所向け。図面がある時は前後比較カードで登録するため非表示） */}
      {phase === "kisetsu" && layout.arrays.length === 0 && (
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>現状を手入力で登録・編集（レイアウト不要）</h2>
          <span className="spacer" />
          <button className="btn secondary small" onClick={addManualLine} disabled={panels.length === 0}>＋ 型式を追加</button>
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          図面を作らない複雑な発電所向け。現状のパネルを<strong>型式＋枚数で入力・編集</strong>して「現状を基準登録」できます。
          概算コストの撤去枚数にも使えます。（図面を配置した場合はこのカードは消え、「前後比較」の登録ボタンを使います）
        </div>
        {manualCurrent.length > 0 && (
          <table className="list" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>パネル型式</th><th className="num">W</th><th className="num">枚数</th><th className="num">出力(kW)</th><th></th></tr>
            </thead>
            <tbody>
              {manualCurrent.map((m) => {
                const p = panels.find((x) => x.id === m.panelId);
                return (
                  <tr key={m.id}>
                    <td>
                      <select value={m.panelId} onChange={(e) => updateManualLine(m.id, { panelId: e.target.value })}>
                        {panels.map((pp) => (<option key={pp.id} value={pp.id}>{pp.maker} {pp.model}（{pp.pmaxW}W）</option>))}
                      </select>
                    </td>
                    <td className="num">{p?.pmaxW ?? "—"}</td>
                    <td className="num">
                      <input type="number" min={0} style={{ width: 90 }} value={m.count} onChange={(e) => updateManualLine(m.id, { count: Number(e.target.value) || 0 })} />
                    </td>
                    <td className="num">{(((m.count || 0) * (p?.pmaxW ?? 0)) / 1000).toFixed(1)}</td>
                    <td className="num"><button className="btn danger small" onClick={() => removeManualLine(m.id)}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr><td className="num"><strong>合計</strong></td><td></td><td className="num"><strong>{manualTotal.toLocaleString()} 枚</strong></td><td className="num"><strong>{manualKw.toFixed(1)} kW</strong></td><td></td></tr>
            </tfoot>
          </table>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={registerBaselineFromManual} disabled={manualTotal === 0}>この内容を現状（基準）として登録</button>
          {manualMsg ? (
            <strong style={{ color: "#22c55e" }}>{manualMsg}</strong>
          ) : (
            <span className="hint">登録すると下の「前後比較」の現状（基準）に入ります。</span>
          )}
        </div>
        {manualMsg && layout.baseline && (
          <div
            className="result-grid"
            style={{ marginTop: 10, padding: "8px 10px", background: "rgba(34,197,94,0.1)", borderRadius: 8 }}
          >
            <div className="metric">
              <div className="label">登録済み 現状（基準）</div>
              <div className="value">{layout.baseline.totalPanels.toLocaleString()}<small> 枚</small></div>
            </div>
            <div className="metric">
              <div className="label">現状 合計出力</div>
              <div className="value">{layout.baseline.totalKw.toFixed(1)}<small> kW</small></div>
            </div>
            <div className="metric" style={{ gridColumn: "span 2" }}>
              <div className="label">型式内訳</div>
              <div className="hint">{layout.baseline.byPanel.map((b) => `${b.model}：${b.count.toLocaleString()}枚`).join(" / ")}</div>
            </div>
          </div>
        )}
      </div>
      )}

      {layout.imageDataUrl && (
        <div className="card" style={{ padding: 0, overflow: "hidden", position: "relative" }}>
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", cursor: wireMode && wireEdit ? "crosshair" : mode === "pan" ? "grab" : "crosshair", touchAction: "none" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => {
              setHoverInfo(null);
              // 範囲ドラッグ中は、画面上のボタン類（回転・戻す等）の上を通っても中断しない。
              // ドラッグ継続はボタン押下の有無で onMouseMove 側が判定する
              if (mode === "scan" || mode === "keeprect" || mode === "removerect" || mode === "missrect" || areaDragRef.current) return;
              onMouseUp();
            }}
            onContextMenu={onContextMenu}
          />
          {/* 右クリックメニュー：クリックしたパネルの編集をその場で行う */}
          {ctxMenu && (() => {
            const arr = layout.arrays.find((a) => a.id === ctxMenu.arrId);
            if (!arr) return null;
            const key = cellKey(ctxMenu.r, ctxMenu.col);
            const isMissing = new Set(arr.missingCells ?? []).has(key);
            const isExisting = arr.keepCells !== undefined;
            const isKept = new Set(arr.keepCells ?? []).has(key);
            const isRemoved = new Set(arr.removedCells ?? []).has(key);
            const curPanelId = arr.cellPanels?.[key] ?? arr.panelId;
            const close = () => setCtxMenu(null);
            const cw = canvasRef.current?.clientWidth ?? 600;
            const left = Math.max(4, Math.min(cw - 250, ctxMenu.x));
            const top = Math.max(4, ctxMenu.y + 6);
            return (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 240,
                  background: "rgba(15, 23, 42, 0.97)",
                  border: "1px solid #334155",
                  borderRadius: 8,
                  padding: 8,
                  zIndex: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div className="hint" style={{ marginTop: 0, display: "flex", alignItems: "center" }}>
                  <span style={{ flex: 1 }}>
                    {isExisting ? "既設" : "新設"}パネル（{ctxMenu.r + 1}行 {ctxMenu.col + 1}列）
                  </span>
                  <button className="cand-icon" title="閉じる" onClick={close}>✕</button>
                </div>
                <button
                  className="btn small"
                  title="ドラッグで囲んで、選んだエリアにまとめて操作（載せ替え・撤去など）"
                  onClick={() => { setMode("areaselect"); close(); }}
                >
                  ▭ ここから範囲選択（ドラッグ）
                </button>
                {isMissing ? (
                  phase === "kisetsu" ? (
                    <button className="btn small" onClick={() => { toggleMissing(arr, ctxMenu.r, ctxMenu.col); close(); }}>
                      ↩ パネルを戻す（欠けを復活）
                    </button>
                  ) : (
                    <span className="hint" style={{ marginTop: 0 }}>パネル無し（形の編集は①で）</span>
                  )
                ) : (
                  <>
                    <div className="field" style={{ margin: 0 }}>
                      <label>このパネルの型式</label>
                      <select
                        value={curPanelId}
                        onChange={(e) => { setCellPanel(arr, ctxMenu.r, ctxMenu.col, e.target.value); close(); }}
                      >
                        {panels.map((p) => (
                          <option key={p.id} value={p.id}>{p.maker} {p.model}（{p.pmaxW}W）</option>
                        ))}
                      </select>
                    </div>
                    {phase === "henkou" && isExisting && !isRemoved && (
                      <button className="btn small secondary" onClick={() => { toggleCell(arr, ctxMenu.r, ctxMenu.col); close(); }}>
                        {isKept ? "→ 入換にする（撤去して載せ替え）" : "↩ 流用に戻す（入換を取り消し）"}
                      </button>
                    )}
                    {phase === "henkou" && (
                      <button className="btn small secondary" onClick={() => { toggleRemove(arr, ctxMenu.r, ctxMenu.col); close(); }}>
                        {isRemoved ? "↩ 撤去を戻す" : "🗑 撤去する（改修で外す）"}
                      </button>
                    )}
                    {phase === "henkou" && (
                      <>
                        <div className="hint" style={{ marginTop: 2 }}>範囲でまとめて（押したらドラッグで囲む）：</div>
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="btn small secondary"
                            style={{ flex: 1 }}
                            title="囲んだ範囲を流用（変更しない）に戻す＝入換・撤去をまとめて取り消し"
                            onClick={() => { setKeepRectValue(true); setMode("keeprect"); rectOnceRef.current = true; close(); }}
                          >
                            ▦ 戻す
                          </button>
                          <button
                            className="btn small secondary"
                            style={{ flex: 1 }}
                            title="囲んだ範囲を入換（撤去して同じ場所に新パネル）にする"
                            onClick={() => { setKeepRectValue(false); setMode("keeprect"); rectOnceRef.current = true; close(); }}
                          >
                            ▦ 入換
                          </button>
                          <button
                            className="btn small secondary"
                            style={{ flex: 1 }}
                            title="囲んだ範囲を撤去（更地）にする"
                            onClick={() => { setRemoveRectValue(true); setMode("removerect"); rectOnceRef.current = true; close(); }}
                          >
                            ▦ 撤去
                          </button>
                        </div>
                      </>
                    )}
                    {phase === "kisetsu" && (
                      <button className="btn small secondary" onClick={() => { toggleMissing(arr, ctxMenu.r, ctxMenu.col); close(); }}>
                        ✂ パネル無しにする（最初から無い所）
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
          {/* エリア選択のアクションパネル：選択範囲の近くに表示し、まとめて操作する */}
          {selSets && !ctxMenu && (() => {
            // 選択の集計と画面上の位置（セル中心ベース）。状態（流用/入換/撤去）も数える
            let count = 0;
            let keptN = 0, removedN = 0, swapN = 0;
            const byType = new Map<string, number>();
            let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const arr of layout.arrays) {
              const keys = selSets.get(arr.id);
              if (!keys?.size) continue;
              const { pw, ph, gapXpx, gapYpx } = arrayPanelPx(arr);
              const rad = (arr.rotationDeg * Math.PI) / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);
              const keepSet = arr.keepCells ? new Set(arr.keepCells) : null;
              const remSet = new Set(arr.removedCells ?? []);
              for (const k of keys) {
                count++;
                const pid = arr.cellPanels?.[k] ?? arr.panelId;
                byType.set(pid, (byType.get(pid) ?? 0) + 1);
                if (remSet.has(k)) removedN++;
                else if (keepSet && !keepSet.has(k)) swapN++; // 既設でkeep無し＝入換
                else keptN++;
                const i = k.indexOf(",");
                const r = Number(k.slice(0, i));
                const c = Number(k.slice(i + 1));
                const lx = c * (pw + gapXpx) + pw / 2;
                const ly = r * (ph + gapYpx) + ph / 2;
                const s = imageToScreen(arr.posXpx + cos * lx - sin * ly, arr.posYpx + sin * lx + cos * ly);
                if (s.x < minX) minX = s.x;
                if (s.x > maxX) maxX = s.x;
                if (s.y > maxY) maxY = s.y;
              }
            }
            if (count === 0) return null;
            const stateLabel = [
              keptN ? `流用${keptN}` : "",
              swapN ? `入換${swapN}` : "",
              removedN ? `撤去${removedN}` : "",
            ].filter(Boolean).join("・");
            const cw = canvasRef.current?.clientWidth ?? 600;
            const chh = canvasRef.current?.clientHeight ?? 600;
            const left = Math.max(4, Math.min(cw - 360, (minX + maxX) / 2 - 175));
            const top = Math.max(4, Math.min(chh - 190, maxY + 14));
            const typeLabel = [...byType.entries()]
              .map(([pid, n]) => {
                const p = panels.find((x) => x.id === pid);
                return `${p ? `${p.pmaxW}W` : "未登録"}×${n}`;
              })
              .join("・");
            return (
              <div
                style={{
                  position: "absolute",
                  left,
                  top,
                  width: 350,
                  background: "rgba(15, 23, 42, 0.97)",
                  border: "1px solid #fff",
                  borderRadius: 8,
                  padding: 8,
                  zIndex: 8,
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div className="hint" style={{ marginTop: 0, display: "flex", alignItems: "center" }}>
                  <strong style={{ flex: 1, color: "#fff" }}>選択中：{count}枚（{typeLabel}）</strong>
                  <button className="cand-icon" title="選択を解除" onClick={() => setSelection(null)}>✕</button>
                </div>
                {phase === "henkou" && stateLabel && (
                  <div className="hint" style={{ marginTop: 0, color: removedN || swapN ? "#fbbf24" : "#94a3b8" }}>
                    現在の状態：{stateLabel}
                  </div>
                )}
                <PanelPicker panels={panels} value={selPanelId} onChange={setSelPanelId} allowEmpty />
                <div style={{ display: "flex", gap: 4 }}>
                  {phase === "henkou" && (
                    <button
                      className="btn small"
                      style={{ flex: 1.4 }}
                      disabled={!selPanelId}
                      title="選択セルを入換にし、同じ位置に選んだ型式の新設配列を自動生成（位置合わせ不要）"
                      onClick={() => selReplace(selPanelId)}
                    >
                      ⇄ この型式で載せ替え
                    </button>
                  )}
                  <button
                    className="btn small secondary"
                    style={{ flex: 1 }}
                    disabled={!selPanelId}
                    title="既設の混在を修正（実体の型式を塗る・全候補共通）"
                    onClick={() => selPaint(selPanelId)}
                  >
                    🎨 塗る
                  </button>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {phase === "henkou" ? (
                    <>
                      <button className="btn small secondary" style={{ flex: 1 }} title="選択を撤去（更地・載せ替えない）" onClick={selRemove}>
                        🗑 撤去
                      </button>
                      <button className="btn small secondary" style={{ flex: 1 }} title="入換・撤去をまとめて流用に戻す（取り消し）" onClick={selRestore}>
                        ↩ 流用に戻す
                      </button>
                    </>
                  ) : (
                    <button className="btn small secondary" style={{ flex: 1 }} title="選択セルを「最初から無い所」として削る（不定形づくり）" onClick={selCarve}>
                      ✂ 削る（無い所）
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          {/* パネルのメーカー名・型式ツールチップ（マウス追従） */}
          {hoverInfo && (
            <div
              style={{
                position: "absolute",
                left: Math.min(hoverInfo.x + 14, (canvasRef.current?.clientWidth ?? 600) - 220),
                top: Math.max(4, hoverInfo.y - 34),
                zIndex: 10,
                pointerEvents: "none",
                background: "rgba(15, 23, 42, 0.95)",
                color: "#e2e8f0",
                border: "1px solid #475569",
                borderRadius: 6,
                padding: "3px 8px",
                fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              {hoverInfo.label}
            </div>
          )}
          {/* 操作結果トースト（撤去・載せ替え等の結果を一時表示） */}
          {opMsg && (
            <div
              style={{
                position: "absolute",
                top: 50,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 9,
                background: "rgba(34,197,94,0.95)",
                color: "#04210f",
                fontWeight: "bold",
                border: "1px solid #bbf7d0",
                borderRadius: 8,
                padding: "6px 16px",
                whiteSpace: "nowrap",
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              {opMsg}
            </div>
          )}
          {/* 範囲モード中の案内バナー（いま何のドラッグ待ちかを常に表示） */}
          {mode === "areaselect" && (
            <div
              className="hint"
              style={{
                position: "absolute",
                top: 10,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 6,
                background: "rgba(15, 23, 42, 0.92)",
                border: "1px solid #fff",
                borderRadius: 8,
                padding: "4px 12px",
                marginTop: 0,
                whiteSpace: "nowrap",
              }}
            >
              ▭ エリア選択：ドラッグで囲んでください（次回からは Shift＋ドラッグだけでもOK）
            </div>
          )}
          {(mode === "keeprect" || mode === "removerect" || mode === "missrect") && (
            <div
              className="hint"
              style={{
                position: "absolute",
                top: 10,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 6,
                background: "rgba(15, 23, 42, 0.92)",
                border: "1px solid #38bdf8",
                borderRadius: 8,
                padding: "4px 12px",
                marginTop: 0,
                whiteSpace: "nowrap",
              }}
            >
              ▦{" "}
              {mode === "keeprect"
                ? keepRectValue
                  ? "範囲を戻す（流用へ）"
                  : "範囲を入換"
                : mode === "removerect"
                  ? removeRectValue
                    ? "範囲を撤去"
                    : "撤去を戻す"
                  : missRectValue
                    ? "範囲を削る"
                    : "欠けを戻す"}
              ：ドラッグで囲んでください
            </div>
          )}
          {/* 戻す・全消去（左上にオーバーレイ） */}
          <div
            style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6 }}
          >
            <button
              className="btn secondary small"
              title="一つ前の状態に戻す"
              onClick={undo}
              disabled={histLen === 0}
            >
              ↩ 戻す
            </button>
            <button
              className="btn danger small"
              title="配置したパネル配列を全消去"
              onClick={clearAllArrays}
              disabled={layout.arrays.length === 0 && (layout.freePanels?.length ?? 0) === 0}
            >
              🗑 全消去
            </button>
            <button
              className={`btn small ${mode === "areaselect" ? "" : "secondary"}`}
              title="ドラッグで囲んだエリアにまとめて操作（載せ替え・撤去・塗り・削り）。Shift＋ドラッグでも開始できます"
              onClick={() => setMode(mode === "areaselect" ? "pan" : "areaselect")}
              disabled={layout.arrays.length === 0}
            >
              ▭ エリア選択
            </button>
          </div>
          {/* 拡大縮小ボタン（右上にオーバーレイ） */}
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <button className="btn secondary small" title="拡大" onClick={() => zoomByCentered(1.25)}>＋</button>
            <button className="btn secondary small" title="縮小" onClick={() => zoomByCentered(1 / 1.25)}>－</button>
            <button
              className="btn small"
              title="パネル設置範囲に最大ズーム"
              onClick={fitToPanels}
            >
              ▣
            </button>
            <button
              className="btn secondary small"
              title="写真全体を表示"
              onClick={() => imgRef.current && fitToView(imgRef.current)}
            >
              ⤢
            </button>
          </div>
          {/* 写真の向き・透過（写真を見ながら調整できるよう右端にオーバーレイ） */}
          {layout.imageDataUrl && (
            <div
              style={{
                position: "absolute",
                top: 170,
                right: 10,
                width: 120,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                background: "rgba(15, 23, 42, 0.88)",
                border: "1px solid #334155",
                borderRadius: 8,
                padding: 8,
                zIndex: 5,
              }}
            >
              <div className="hint" style={{ marginTop: 0 }}>向き: {layout.imageRotationDeg}°</div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="btn secondary small" style={{ flex: 1 }} title="左へ90°回す" onClick={() => rotate(-90)}>⟲90</button>
                <button className="btn secondary small" style={{ flex: 1 }} title="右へ90°回す" onClick={() => rotate(90)}>⟳90</button>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="btn secondary small" style={{ flex: 1 }} title="左へ1°回す" onClick={() => rotate(-1)}>⟲1</button>
                <button className="btn secondary small" style={{ flex: 1 }} title="右へ1°回す" onClick={() => rotate(1)}>⟳1</button>
              </div>
              <input
                type="range"
                min={0}
                max={359}
                value={layout.imageRotationDeg}
                title="向き（回転）"
                onChange={(e) => setRotation(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div className="hint" style={{ marginTop: 0 }}>透過: {(layout.imageOpacity * 100) | 0}%</div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={layout.imageOpacity}
                title="背景の透過度"
                onChange={(e) => patchContinuous("imgopacity", { imageOpacity: Number(e.target.value) })}
                style={{ width: "100%" }}
              />
            </div>
          )}
          {/* 結線編集用の戻す/進める（クリック位置に出る・全体の戻すとは独立） */}
          {wireMode && wireEdit && (
            <div
              data-rev={wireHist}
              style={{
                position: "absolute",
                left: wirePopPos ? Math.max(4, Math.min((canvasRef.current?.clientWidth ?? 600) - 130, wirePopPos.x - 34)) : "50%",
                top: wirePopPos ? Math.max(4, wirePopPos.y - 46) : 8,
                transform: wirePopPos ? "none" : "translateX(-50%)",
                display: "flex",
                gap: 4,
                zIndex: 6,
              }}
            >
              <button className="btn small" disabled={wireUndoRef.current.length === 0} onClick={wireUndo} title="結線編集を1つ戻す">↶ 戻す</button>
              <button className="btn small" disabled={wireRedoRef.current.length === 0} onClick={wireRedo} title="結線編集を1つ進める">↷ 進める</button>
            </div>
          )}
          <div className="hint" style={{ padding: "6px 12px" }}>
            ドラッグ＝移動／ホイール or ＋−ボタン＝ズーム／▣＝パネルに最大化／⤢＝写真全体／↩戻す・🗑全消去／配列をドラッグで位置調整／<strong>パネルを右クリック＝1枚メニュー（型式変更・削る・撤去）</strong>
          </div>

          {/* 結線図（パワコン構成からストリングを自動割付）— 変更の検討フェーズのみ */}
          {phase === "henkou" && (
          <div style={{ padding: "8px 12px", borderTop: "1px solid #1e293b" }}>
            <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <button
                className={`btn small ${wireMode ? "" : "secondary"}`}
                onClick={() => { setWireMode(!wireMode); if (wireMode) setWireEdit(false); }}
              >
                {wireMode ? "🔌 結線表示：ON" : "🔌 結線図を表示（パワコン割付）"}
              </button>
              <button className="btn secondary small no-print" onClick={exportConstructionPdf} title="表紙＋現在の図面＋完成後＋パワコン構成をPDFに">
                📄 工事説明書PDF
              </button>
              <button className={`btn small no-print ${showW ? "" : "secondary"}`} onClick={() => setShowW(!showW)} title="パネルにW値を表示">
                {showW ? "W表示：ON" : "W表示：OFF"}
              </button>
              {wireMode && (
                <>
                  <button
                    className={`btn small ${wireEdit ? "" : "secondary"}`}
                    onClick={() => setWireEdit(!wireEdit)}
                  >
                    {wireEdit ? "✏ 編集中：パネルをクリックで割付" : "✏ 結線を手編集"}
                  </button>
                  <button className="btn secondary small no-print" onClick={exportCanvasPdf}>
                    🖨 結線図をPDF印刷
                  </button>
                  {layout.wiringOverrides && Object.keys(layout.wiringOverrides).length > 0 && (
                    <button className="btn secondary small" onClick={clearWiringOverrides}>
                      手編集をクリア（{Object.keys(layout.wiringOverrides).length}）
                    </button>
                  )}
                </>
              )}
            </div>

            {wireMode && wireEdit && (
              <div className="row" style={{ marginTop: 6, alignItems: "flex-end", gap: 8, padding: "6px 8px", background: "#0b1220", borderRadius: 8 }}>
                <div className="field" style={{ width: 90 }}>
                  <label>PC番号</label>
                  <input type="number" min={1} value={editPc} onChange={(e) => setEditPc(Math.max(1, Number(e.target.value) || 1))} />
                </div>
                <div className="field" style={{ width: 90 }}>
                  <label>ストリング</label>
                  <input type="number" min={1} value={editStr} onChange={(e) => setEditStr(Math.max(1, Number(e.target.value) || 1))} />
                </div>
                <div className="field" style={{ width: 90 }}>
                  <label>並列</label>
                  <input type="number" min={1} value={editPar} onChange={(e) => setEditPar(Math.max(1, Number(e.target.value) || 1))} />
                </div>
                <span className="hint" style={{ flex: 1 }}>
                  上の番号にしたいパネルを<strong>クリック</strong>すると「{editPc}-{editStr}-{editPar}」に割付（色も変わる）。
                  まとめて消すなら「手編集をクリア」。
                </span>
              </div>
            )}
            {wireMode && wiring && wiring.perPcs.length > 0 && (
              <div className="row" style={{ marginTop: 6, gap: 10, flexWrap: "wrap" }}>
                {wiring.perPcs.map((p) => (
                  <span key={p.pcsNo} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ width: 14, height: 14, borderRadius: 3, background: p.color, display: "inline-block" }} />
                    <span className="hint">PC{p.pcsNo}：{p.panels}枚／{p.strings}str</span>
                  </span>
                ))}
              </div>
            )}
            {wireMode && (pcsUnits?.length ?? 0) === 0 && (
              <div className="hint" style={{ marginTop: 4, color: "var(--warn)" }}>
                ⚠ パワコン構成が未設定です。「パワコン構成」タブで台数・ストリングを設定すると結線が描かれます。
              </div>
            )}
          </div>
          )}

          {/* 写真の下：現状の説明・凡例 — 変更の検討フェーズのみ（PDF用） */}
          {phase === "henkou" && (
          <div style={{ padding: "8px 12px", borderTop: "1px solid #1e293b" }}>
            <div className="row" style={{ alignItems: "center" }}>
              <strong>現状の説明・凡例</strong>
              <span className="spacer" />
              <button className="btn secondary small no-print" onClick={genLegend}>図面から自動生成</button>
              <button className="btn secondary small no-print" onClick={addLegend}>＋ 行を追加</button>
            </div>
            {legend.length === 0 ? (
              <div className="hint" style={{ marginTop: 4 }}>
                「図面から自動生成」で 緑＝既設／青＝新設 の説明を作成。手入力で枚数・既設/新設・向きを調整できます。
              </div>
            ) : (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                {legend.map((l) => (
                  <div key={l.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                    <input
                      type="color"
                      value={l.color}
                      title="色"
                      onChange={(e) => updateLegend(l.id, { color: e.target.value })}
                      style={{ width: 34, height: 28, padding: 0, border: "none", background: "none", cursor: "pointer" }}
                    />
                    <span
                      aria-hidden
                      style={{ width: 14, height: 14, borderRadius: 3, background: l.color, display: "inline-block", flex: "0 0 auto" }}
                    />
                    <input
                      type="text"
                      value={l.label}
                      placeholder="例) トリナソーラー 360W 150枚 既設 横"
                      onChange={(e) => updateLegend(l.id, { label: e.target.value })}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="btn danger small no-print" onClick={() => removeLegend(l.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
        </div>
      )}

      {layout.imageDataUrl && (
        <div className="card">
          <h2>{phase === "kisetsu" ? "既設パネルの配置（スキャン・配列追加）" : "新設パネルの配置（入替・増設用の配列を追加）"}</h2>
          {panels.length === 0 ? (
            <div className="empty">先に「パネル登録」でパネルを登録してください。</div>
          ) : (
            <div className="form-grid">
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <label>パネル（メーカー・出力で絞り込み）</label>
                <PanelPicker panels={panels} value={formPanelId} onChange={setFormPanelId} allowEmpty />
              </div>
              <div className="field">
                <label>向き</label>
                <select value={formOrient} onChange={(e) => setFormOrient(e.target.value as "portrait" | "landscape")}>
                  <option value="portrait">縦置き</option>
                  <option value="landscape">横置き</option>
                </select>
              </div>
              <div className="field">
                <label>行数（縦）</label>
                <input type="number" min={1} value={formRows} onChange={(e) => setFormRows(Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
              </div>
              <div className="field">
                <label>列数（横）</label>
                <input type="number" min={1} value={formCols} onChange={(e) => setFormCols(Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
              </div>
              <div className="field">
                <label>横の隙間 (m)</label>
                <input type="number" step={0.01} value={formGapX} onChange={(e) => setFormGapX(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>縦の隙間 (m)</label>
                <input type="number" step={0.01} value={formGapY} onChange={(e) => setFormGapY(Number(e.target.value))} />
              </div>
              <div className="field" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={addArray}>配列を追加</button>
              </div>
            </div>
          )}
          <div className="hint" style={{ marginTop: 4 }}>
            <strong>横の隙間</strong>＝パネルの左右（桁間）、<strong>縦の隙間</strong>＝行の前後（アレイ離隔）。
            両面パネルは裏面採光のため<strong>縦（前後）の隙間を広め</strong>に取るのが一般的です。
          </div>

          {phase === "kisetsu" && panels.length > 0 && (
            <div className="row" style={{ marginTop: 6, padding: "8px 10px", background: "#0b1220", borderRadius: 8 }}>
              <button
                className={`btn small ${mode === "scan" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "scan" ? "pan" : "scan")}
              >
                {mode === "scan" ? "スキャン中：アレイをドラッグで囲む" : "🔍 既設パネルをスキャン（範囲ドラッグ）"}
              </button>
              <span className="hint">
                上で選んだ<strong>パネル・向き・間隔</strong>を使い、囲んだ範囲の<strong>実寸÷パネル寸法</strong>で
                行×列を自動計算して配列を生成します。
                {layout.calibration ? "" : "（先に地理院地図の取得かスケール設定が必要）"}
                アレイが斜めなら、先に写真を回して水平にしてから囲むと正確です。
              </span>
            </div>
          )}

          {/* 不定形（L字・へこみ・端数行）：大きめの矩形を置いて「パネルの無い所」を削る。
              形＝既設マスタの編集（全候補共通）なので①専用。②で外すのは「撤去」（候補ごと） */}
          {phase === "kisetsu" && layout.arrays.length > 0 && (
            <div className="row" style={{ marginTop: 6 }}>
              <button
                className={`btn small ${mode === "missing" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "missing" ? "pan" : "missing")}
              >
                {mode === "missing" ? "削り中：セルをクリックで削る/戻す" : "✂ 1枚ずつ削る/戻す（無い所）"}
              </button>
              <button
                className={`btn small ${mode === "missrect" && missRectValue ? "" : "secondary"}`}
                onClick={() => { setMissRectValue(true); setMode(mode === "missrect" && missRectValue ? "pan" : "missrect"); }}
              >
                {mode === "missrect" && missRectValue ? "範囲削り中：ドラッグで囲む" : "▦ 範囲を削る（ドラッグ）"}
              </button>
              <button
                className={`btn small ${mode === "missrect" && !missRectValue ? "" : "secondary"}`}
                onClick={() => { setMissRectValue(false); setMode(mode === "missrect" && !missRectValue ? "pan" : "missrect"); }}
              >
                {mode === "missrect" && !missRectValue ? "範囲戻し中：ドラッグで囲む" : "▦ 範囲を戻す（ドラッグ）"}
              </button>
              <span className="hint" style={{ flex: 1 }}>
                <strong>不定形（L字・へこみ・端数行）用</strong>：大きめに配列を置き、パネルの<strong>無い所</strong>を削って形を合わせます。
                削った分は枚数・kW・コスト・結線のすべてから除外（②の「撤去」＝改修で外す、とは別物）。
                削り編集中は削った位置が赤破線で見え、戻すこともできます。
              </span>
            </div>
          )}

          {/* 混在パネル：同サイズの別機種が1枚ずつ混ざる配列を、セルごとに型式変更（入替検討＝変更フェーズ） */}
          {phase === "henkou" && panels.length > 0 && (
            <div className="row" style={{ marginTop: 6, padding: "8px 10px", background: "#0b1220", borderRadius: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
              <button
                className={`btn small ${mode === "cellpanel" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "cellpanel" ? "pan" : "cellpanel")}
              >
                {mode === "cellpanel" ? "混在編集中：セルをクリックで型式変更" : "▦ 混在パネル（セルごとに型式変更）"}
              </button>
              <div className="field" style={{ minWidth: 320 }}>
                <label>割り当てる型式（メーカー・出力で絞り込み）</label>
                <PanelPicker panels={panels} value={cellPanelTarget} onChange={setCellPanelTarget} />
              </div>
              <span className="hint" style={{ flex: 1 }}>
                同サイズの別機種が混ざる配列で、<strong>セルをクリック</strong>して型式を切替（橙枠＋W値表示）。
                配列の既定型式に戻すと枠が消えます。枚数・kW・コストは<strong>型式ごとに自動集計</strong>。
              </span>
            </div>
          )}

          {phase === "henkou" && panels.length > 0 && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn secondary" onClick={addFreePanel}>＋ 1枚追加（単独パネル）</button>
              {freeCount > 0 && (
                <>
                  <span className="badge">単独パネル {freeCount} 枚</span>
                  <button className="btn danger small" onClick={clearFreePanels}>単独パネルを全消去</button>
                </>
              )}
              <span className="hint">
                上の「パネル」「向き」で<strong>1枚だけ</strong>追加（ピンク）。端の増設や、横置きの中に縦置きを混ぜる用。
                ※「配列を追加」は<strong>行×列のまとまり</strong>を置くボタンで別物です（1×1だと1枚に見えます）。
              </span>
            </div>
          )}

          {selectedFree && (
            <div style={{ marginTop: 12 }}>
              <h3>選択中の単独パネル</h3>
              <div className="form-grid">
                <div className="field">
                  <label>パネル</label>
                  <select value={selectedFree.panelId} onChange={(e) => updateFree(selectedFree.id, { panelId: e.target.value })}>
                    {panels.map((p) => (
                      <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>向き</label>
                  <select value={selectedFree.orientation} onChange={(e) => updateFree(selectedFree.id, { orientation: e.target.value as "portrait" | "landscape" })}>
                    <option value="portrait">縦置き</option>
                    <option value="landscape">横置き</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1, minWidth: 200 }}>
                  <label>回転: {selectedFree.rotationDeg}°</label>
                  <input type="range" min={-180} max={180} value={selectedFree.rotationDeg} onChange={(e) => updateFree(selectedFree.id, { rotationDeg: Number(e.target.value) }, "rot-free")} />
                </div>
                <div className="field" style={{ justifyContent: "flex-end" }}>
                  <button className="btn danger" onClick={() => deleteFree(selectedFree.id)}>このパネルを削除</button>
                </div>
              </div>
            </div>
          )}

          {layout.arrays.length > 0 && (
            <table className="list" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>配列</th>
                  <th className="num">行×列</th>
                  <th className="num">枚数</th>
                  <th>向き</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {layout.arrays.map((a, i) => {
                  // ①既設の設定では既設配列のみ表示（②の新設は変更の検討で編集）。番号は通し番号を維持
                  if (phase === "kisetsu" && a.keepCells === undefined) return null;
                  const s = arrayCellStats(a);
                  const missingN = a.rows * a.cols - s.grid; // 欠け（最初から無い）枚数
                  // 型式別の実数内訳（欠け除外・セルごとの型式上書きを考慮）
                  const byType = (() => {
                    const m = new Map<string, number>();
                    const missing = new Set(a.missingCells ?? []);
                    for (let r = 0; r < a.rows; r++)
                      for (let c = 0; c < a.cols; c++) {
                        const k = cellKey(r, c);
                        if (missing.has(k)) continue;
                        const pid = a.cellPanels?.[k] ?? a.panelId;
                        m.set(pid, (m.get(pid) ?? 0) + 1);
                      }
                    return [...m.entries()].map(([pid, n]) => {
                      const pp = panels.find((x) => x.id === pid);
                      return { pid, label: pp ? `${pp.model}（${pp.pmaxW}W）` : "未登録パネル", n };
                    });
                  })();
                  return (
                    <tr
                      key={a.id}
                      style={{ outline: a.id === selectedId ? "1px solid #fff" : undefined, cursor: "pointer" }}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <td>
                        <span style={{ color: arrayDispColor(a.color) }}>■</span> 配列{i + 1}
                        {byType.map((t) => (
                          <div className="hint" key={t.pid}>
                            {t.label} × {t.n}枚
                          </div>
                        ))}
                      </td>
                      <td className="num">
                        {a.rows}×{a.cols}
                        {missingN > 0 && (
                          <div className="hint" style={{ color: "#f59e0b" }}>変則（欠け{missingN}）</div>
                        )}
                      </td>
                      <td className="num">
                        {s.grid}
                        {(() => {
                          // 区分の見える化：流用マーク定義済み＝既設／無し＝新設（概算コスト・削除ガードと同じ判定）
                          if (s.marked) {
                            return (
                              <span className="hint" style={{ color: KEEP_COLOR }}>
                                {" "}既設{phase === "henkou" ? `（流用${s.keep}）` : ""}
                              </span>
                            );
                          }
                          return <span className="hint" style={{ color: "#38bdf8" }}> 新設</span>;
                        })()}
                      </td>
                      <td>{a.orientation === "portrait" ? "縦" : "横"}</td>
                      <td className="num">
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <button
                            className={`btn small ${a.id === selectedId ? "" : "secondary"}`}
                            onClick={(e) => { e.stopPropagation(); setSelectedId(a.id); setSelectedFreeId(null); }}
                          >
                            編集
                          </button>
                          <button className="btn danger small" onClick={(e) => { e.stopPropagation(); deleteArray(a.id); }}>削除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {selected && (
            <div style={{ marginTop: 12 }}>
              <h3>選択中の配列を調整</h3>
              <div className="form-grid">
                <div className="field" style={{ gridColumn: "1 / -1" }}>
                  <label>パネル（型式の変更・メーカー・出力で絞り込み）</label>
                  <PanelPicker
                    panels={panels}
                    value={selected.panelId}
                    onChange={(id) => updateArray(selected.id, { panelId: id })}
                  />
                </div>
                <div className="field">
                  <label>行数</label>
                  <input type="number" min={1} value={selected.rows} onChange={(e) => resizeArray(selected.id, { rows: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>列数</label>
                  <input type="number" min={1} value={selected.cols} onChange={(e) => resizeArray(selected.id, { cols: Number(e.target.value) })} />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 200 }}>
                  <label>配列の回転: {selected.rotationDeg}°</label>
                  <input type="range" min={-180} max={180} value={selected.rotationDeg} onChange={(e) => updateArray(selected.id, { rotationDeg: Number(e.target.value) }, "rot-arr")} />
                </div>
                <div className="field">
                  <label>向き</label>
                  <select value={selected.orientation} onChange={(e) => updateArray(selected.id, { orientation: e.target.value as "portrait" | "landscape" })}>
                    <option value="portrait">縦置き</option>
                    <option value="landscape">横置き</option>
                  </select>
                </div>
                <div className="field">
                  <label>横の隙間 (m)</label>
                  <input type="number" step={0.01} value={selected.gapM} onChange={(e) => updateArray(selected.id, { gapM: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>縦の隙間 (m)</label>
                  <input
                    type="number"
                    step={0.01}
                    value={selected.gapYm ?? selected.gapM}
                    onChange={(e) => updateArray(selected.id, { gapYm: Number(e.target.value) })}
                  />
                </div>
              </div>
              {phase === "henkou" && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="hint">この配列の撤去：</span>
                  <button className="btn secondary small" title="全パネルを撤去（更地・載せ替えない）にする" onClick={() => setAllRemoved(selected.id, true)}>全部撤去</button>
                  <button className="btn secondary small" title="この配列の撤去指定をすべて解除する" onClick={() => setAllRemoved(selected.id, false)}>撤去解除</button>
                  <span className="hint">撤去 {arrayCellStats(selected).removed} 枚／流用 {arrayCellStats(selected).keep} 枚</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ①既設の設定：既設パネルの内訳（型式別の枚数・kW を図面から自動集計） */}
      {phase === "kisetsu" && (() => {
        const sum = summarizeLayout(layout, panels, "genkyo");
        if (sum.totalPanels === 0) return null;
        return (
          <div className="card">
            <h2>既設パネルの内訳</h2>
            <table className="list">
              <thead>
                <tr>
                  <th>パネル型式</th>
                  <th className="num">枚数</th>
                  <th className="num">出力(kW)</th>
                </tr>
              </thead>
              <tbody>
                {sum.byPanel.map((b) => (
                  <tr key={b.model}>
                    <td>{b.model}</td>
                    <td className="num">{b.count.toLocaleString()}</td>
                    <td className="num">{b.kw.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td><strong>合計</strong></td>
                  <td className="num"><strong>{sum.totalPanels.toLocaleString()} 枚</strong></td>
                  <td className="num"><strong>{sum.totalKw.toFixed(1)} kW</strong></td>
                </tr>
              </tfoot>
            </table>
            <div className="hint" style={{ marginTop: 4 }}>
              ①の図面（既設のみ）から自動集計しています。図面を直すとここも変わります。
              「現状を基準登録」した数字（前後比較の改修前）は登録時点で固定され、こことは独立です。
            </div>
          </div>
        );
      })()}

      {(layout.imageDataUrl || layout.baseline || manualCurrent.length > 0 || layout.arrays.length > 0) && (
        <div className="card">
          <h2>{phase === "kisetsu" ? "現状の基準登録（既設の仕上げ）" : "前後比較（現状 ⇔ 改修案）"}</h2>
          <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            {!layout.baseline ? (
              <button className="btn" onClick={registerBaseline}>現状を基準登録（改修前を保存）</button>
            ) : (
              <>
                <span className="badge new">✓ 現状（基準）登録済み・固定{layout.baseline.arrays?.length ? "（図面も凍結）" : ""}</span>
                <button className="btn secondary small" onClick={registerBaseline}>取り直す（今の内容で上書き）</button>
                {!!layout.baseline.arrays?.length && (
                  <button className="btn secondary small" onClick={restoreExistingFromBaseline} title="既設の図面（形・配置）を登録した時点に戻す">
                    ⏪ 図面を登録時点に戻す（既設）
                  </button>
                )}
                <button className="btn danger small" onClick={clearBaseline}>削除</button>
              </>
            )}
            {manualMsg && <strong style={{ color: "#22c55e" }}>{manualMsg}</strong>}
            {phase === "kisetsu" && layout.baseline && (
              <>
                <span className="spacer" />
                <button className="btn" onClick={() => switchPhase("henkou")}>→ ② 変更の検討へ進む</button>
              </>
            )}
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            <strong>現状（基準）＝改修前</strong>：登録した時点で<strong>数値も既設の図面も固定保存</strong>されます。
            図面を壊してしまっても「⏪ 図面を登録時点に戻す」で復元できます。
            <strong>改修案＝改修後</strong>：図面の編集に合わせて<strong>自動更新</strong>（登録操作は不要）。
            「取り直す」を押すと現状（数値・図面とも）が今の内容で上書きされます。
            {layout.baseline && !layout.baseline.arrays?.length && (
              <strong>（旧形式の基準のため図面が未保存です。既設を直したら「取り直す」を1回押すと図面も凍結されます）</strong>
            )}
          </div>

          {phase === "henkou" && (() => {
            const cur = summarizeLayout(layout, panels, "kaishu");
            const base = layout.baseline;
            const fmt = (n: number) => n.toLocaleString();
            const kw = (n: number) => n.toFixed(1);
            return (
              <table className="list" style={{ marginTop: 12 }}>
                <thead>
                  <tr>
                    <th></th>
                    <th className="num">合計枚数</th>
                    <th className="num">合計出力(kW)</th>
                    <th>型式内訳</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>現状（基準・改修前）</strong>
                      <div className="hint">{base ? "登録済み・固定" : "未登録"}</div>
                    </td>
                    <td className="num">{base ? fmt(base.totalPanels) : "—"}</td>
                    <td className="num">{base ? kw(base.totalKw) : "—"}</td>
                    <td className="hint">
                      {base
                        ? base.byPanel.map((b) => `${b.model}：${fmt(b.count)}枚(${kw(b.kw)}kW)`).join(" / ")
                        : "「現状を基準登録」を押すと記録されます"}
                    </td>
                  </tr>
                  <tr>
                    <td><strong>改修案（改修後・自動）</strong></td>
                    <td className="num">{fmt(cur.totalPanels)}</td>
                    <td className="num">{kw(cur.totalKw)}</td>
                    <td className="hint">
                      {cur.byPanel.map((b) => `${b.model}：${fmt(b.count)}枚(${kw(b.kw)}kW)`).join(" / ") || "—"}
                    </td>
                  </tr>
                  {base && (
                    <tr style={{ background: "#0b1220" }}>
                      <td><strong>差分（改修後−現状）</strong></td>
                      <td className="num" style={{ color: cur.totalPanels - base.totalPanels >= 0 ? "#22c55e" : "#f43f5e" }}>
                        {cur.totalPanels - base.totalPanels >= 0 ? "+" : ""}{fmt(cur.totalPanels - base.totalPanels)}
                      </td>
                      <td className="num" style={{ color: cur.totalKw - base.totalKw >= 0 ? "#22c55e" : "#f43f5e" }}>
                        {cur.totalKw - base.totalKw >= 0 ? "+" : ""}{kw(cur.totalKw - base.totalKw)}
                      </td>
                      <td className="hint">出力が増える分はパワコン上限（低圧≈49.5kW）でピークカットされる点に注意</td>
                    </tr>
                  )}
                </tbody>
              </table>
            );
          })()}
          <div className="hint" style={{ marginTop: 6 }}>
            ※ 入れ替えで撤去する既存パネルは「パネルを撤去」で外すと、現在（改修案）の枚数に正しく反映されます。
          </div>
        </div>
      )}
    </>
  );
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  zoom: number
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / zoom;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  for (const [x, y] of [[x1, y1], [x2, y2]] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 4 / zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}
