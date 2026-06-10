import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSpec, LayoutProject, PanelArray, ShadowZone, FreePanel } from "../types";
import { cellKey } from "../types";
import { shadedCellKeys, pointInZones } from "../calc/shadow";
import { fileToScaledDataUrl } from "../utils/image";
import { uid } from "../store";

const KEEP_COLOR = "#22c55e"; // 流用（変更しない）パネルの色

interface Props {
  panels: PanelSpec[];
  layout: LayoutProject;
  patch: (p: Partial<LayoutProject>) => void;
}

interface View {
  tx: number;
  ty: number;
  zoom: number;
}

const ARRAY_COLORS = ["#38bdf8", "#22c55e", "#f59e0b", "#a78bfa", "#f472b6"];

export function LayoutEditor({ panels, layout, patch }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);
  const [view, setView] = useState<View>({ tx: 40, ty: 40, zoom: 0.5 });
  const [mode, setMode] = useState<"pan" | "calibrate" | "select" | "shadow" | "remove">("pan");
  const [calibPts, setCalibPts] = useState<{ x: number; y: number }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFreeId, setSelectedFreeId] = useState<string | null>(null);
  const [shadowDraft, setShadowDraft] = useState<ShadowZone | null>(null);

  // 配置フォーム
  const [formPanelId, setFormPanelId] = useState(panels[0]?.id ?? "");
  const [formOrient, setFormOrient] = useState<"portrait" | "landscape">("portrait");
  const [formRows, setFormRows] = useState(10);
  const [formCols, setFormCols] = useState(10);
  const [formGap, setFormGap] = useState(0.02);

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
      fitToView(img);
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
      return { pw, ph, gapPx: arr.gapM * pixelsPerMeter };
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
      const dims = arrayPanelPx(arr);
      const { pw, ph, gapPx } = dims;
      ctx.save();
      ctx.translate(arr.posXpx, arr.posYpx);
      ctx.rotate((arr.rotationDeg * Math.PI) / 180);
      const selected = arr.id === selectedId;
      const keep = new Set(arr.keepCells ?? []);
      const removed = new Set(arr.removedCells ?? []);
      const shaded = shadedCellKeys(arr, dims, zones);
      for (let r = 0; r < arr.rows; r++) {
        for (let col = 0; col < arr.cols; col++) {
          const x = col * (pw + gapPx);
          const y = r * (ph + gapPx);
          // 撤去セルは空き枠（破線）で表示し、カウントしない
          if (removed.has(cellKey(r, col))) {
            ctx.strokeStyle = "#64748b";
            ctx.lineWidth = 1 / view.zoom;
            ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
            ctx.strokeRect(x, y, pw, ph);
            ctx.setLineDash([]);
            continue;
          }
          const isKeep = keep.has(cellKey(r, col));
          ctx.fillStyle = (isKeep ? KEEP_COLOR : arr.color) + (isKeep ? "66" : "44");
          ctx.strokeStyle = isKeep ? KEEP_COLOR : selected ? "#fff" : arr.color;
          ctx.lineWidth = (isKeep ? 1.5 : selected ? 2 : 1) / view.zoom;
          ctx.fillRect(x, y, pw, ph);
          ctx.strokeRect(x, y, pw, ph);
          // 影に入るセルは暗くオーバーレイ
          if (shaded.has(cellKey(r, col))) {
            ctx.fillStyle = "rgba(15,23,42,0.55)";
            ctx.fillRect(x, y, pw, ph);
          }
        }
      }
      // 選択枠
      if (selected) {
        const totalW = arr.cols * pw + (arr.cols - 1) * gapPx;
        const totalH = arr.rows * ph + (arr.rows - 1) * gapPx;
        ctx.strokeStyle = "#fff";
        ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(-4, -4, totalW + 8, totalH + 8);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // 単独パネル
    for (const fp of layout.freePanels ?? []) {
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
  }, [view, rot, layout, selectedId, selectedFreeId, calibPts, shadowDraft, arrayPanelPx, freePanelPx]);

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

  function hitFree(ix: number, iy: number): FreePanel | null {
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
      const { pw, ph, gapPx } = arrayPanelPx(arr);
      const totalW = arr.cols * pw + (arr.cols - 1) * gapPx;
      const totalH = arr.rows * ph + (arr.rows - 1) * gapPx;
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
      const { pw, ph, gapPx } = arrayPanelPx(arr);
      const dx = ix - arr.posXpx;
      const dy = iy - arr.posYpx;
      const a = (-arr.rotationDeg * Math.PI) / 180;
      const lx = Math.cos(a) * dx - Math.sin(a) * dy;
      const ly = Math.sin(a) * dx + Math.cos(a) * dy;
      const col = Math.floor(lx / (pw + gapPx));
      const r = Math.floor(ly / (ph + gapPx));
      if (r >= 0 && r < arr.rows && col >= 0 && col < arr.cols) {
        // セル内（隙間でない）か確認
        const cx = lx - col * (pw + gapPx);
        const cy = ly - r * (ph + gapPx);
        if (cx <= pw && cy <= ph) return { arr, r, col };
      }
    }
    return null;
  }

  function toggleCell(arr: PanelArray, r: number, col: number) {
    const key = cellKey(r, col);
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
    const removed = new Set(arr.removedCells ?? []);
    if (removed.has(key)) removed.delete(key);
    else removed.add(key);
    patch({
      arrays: layout.arrays.map((a) =>
        a.id === arr.id ? { ...a, removedCells: [...removed] } : a
      ),
    });
  }

  function setAllCells(arrId: string, keepAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== arrId) return a;
        if (!keepAll) return { ...a, keepCells: [] };
        const all: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) all.push(cellKey(r, c));
        return { ...a, keepCells: all };
      }),
    });
  }

  function invertCells(arrId: string) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (a.id !== arrId) return a;
        const keep = new Set(a.keepCells ?? []);
        const next: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) {
            const k = cellKey(r, c);
            if (!keep.has(k)) next.push(k);
          }
        return { ...a, keepCells: next };
      }),
    });
  }

  function onMouseDown(e: React.MouseEvent) {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (mode === "shadow") {
      shadowStartRef.current = screenToImage(sx, sy);
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

    // 影ゾーンのドラッグ描画
    if (mode === "shadow" && shadowStartRef.current) {
      const cur = screenToImage(sx, sy);
      setShadowDraft(rectFrom(shadowStartRef.current, cur));
      return;
    }

    const d = dragRef.current;
    if (!d) return;
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
      patch({
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
      patch({
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
    // 影ゾーンの確定
    if (mode === "shadow" && shadowStartRef.current) {
      shadowStartRef.current = null;
      if (shadowDraft && shadowDraft.w > 4 && shadowDraft.h > 4) {
        const zone: ShadowZone = { ...shadowDraft, id: uid("shadow") };
        patch({ shadowZones: [...(layout.shadowZones ?? []), zone] });
      }
      setShadowDraft(null);
    }
  }

  function onWheel(e: React.WheelEvent) {
    const c = canvasRef.current!;
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
  }

  // --- 操作ハンドラ ---
  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await fileToScaledDataUrl(file);
      patch({ imageDataUrl: url, calibration: null, arrays: [] });
    } catch {
      alert("画像の読み込みに失敗しました");
    }
    e.target.value = "";
  }

  function rotate(delta: number) {
    patch({ imageRotationDeg: (layout.imageRotationDeg + delta + 360) % 360 });
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
      gapM: formGap,
      posXpx: center.x,
      posYpx: center.y,
      rotationDeg: 0,
      color: ARRAY_COLORS[layout.arrays.length % ARRAY_COLORS.length],
    };
    patch({ arrays: [...layout.arrays, arr] });
    setSelectedId(arr.id);
  }

  function updateArray(id: string, p: Partial<PanelArray>) {
    patch({ arrays: layout.arrays.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  }
  function deleteArray(id: string) {
    patch({ arrays: layout.arrays.filter((a) => a.id !== id) });
    if (selectedId === id) setSelectedId(null);
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
      rotationDeg: 0,
      color: "#f472b6",
    };
    patch({ freePanels: [...(layout.freePanels ?? []), fp] });
    setSelectedFreeId(fp.id);
    setSelectedId(null);
  }
  function updateFree(id: string, p: Partial<FreePanel>) {
    patch({ freePanels: (layout.freePanels ?? []).map((f) => (f.id === id ? { ...f, ...p } : f)) });
  }
  function deleteFree(id: string) {
    patch({ freePanels: (layout.freePanels ?? []).filter((f) => f.id !== id) });
    if (selectedFreeId === id) setSelectedFreeId(null);
  }

  const selected = layout.arrays.find((a) => a.id === selectedId) ?? null;
  const selectedFree = (layout.freePanels ?? []).find((f) => f.id === selectedFreeId) ?? null;
  const freeCount = (layout.freePanels ?? []).length;
  const removedTotal = layout.arrays.reduce((s, a) => s + (a.removedCells?.length ?? 0), 0);
  const arrayCells = layout.arrays.reduce((s, a) => s + a.rows * a.cols, 0);
  const totalPanels = arrayCells - removedTotal + freeCount;
  const keepTotal = layout.arrays.reduce((s, a) => s + (a.keepCells?.length ?? 0), 0);
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

  function setAllPlant(keepAll: boolean) {
    patch({
      arrays: layout.arrays.map((a) => {
        if (!keepAll) return { ...a, keepCells: [] };
        const all: string[] = [];
        for (let r = 0; r < a.rows; r++)
          for (let c = 0; c < a.cols; c++) all.push(cellKey(r, c));
        return { ...a, keepCells: all };
      }),
    });
  }

  return (
    <>
      <div className="card">
        <h2>現況レイアウト（航空写真トレース）</h2>
        <div className="row">
          <label className="btn secondary small" style={{ cursor: "pointer" }}>
            写真をアップロード
            <input type="file" accept="image/*" onChange={onUpload} style={{ display: "none" }} />
          </label>
          {imgReady && (
            <button className="btn secondary small" onClick={() => imgRef.current && fitToView(imgRef.current)}>
              全体表示
            </button>
          )}
          {layout.imageDataUrl && (
            <button className="btn secondary small" onClick={exportPng}>
              図面をPNG保存
            </button>
          )}
          <span className="spacer" />
          <span className="hint">
            {layout.calibration
              ? `スケール: ${pixelsPerMeter.toFixed(1)} px/m`
              : "未校正（基準寸法を設定してください）"}
            ／ 合計 {totalPanels} 枚（流用 {keepTotal}{removedTotal ? ` / 撤去 ${removedTotal}` : ""}{freeCount ? ` / 追加 ${freeCount}` : ""}）
          </span>
        </div>

        {!layout.imageDataUrl && (
          <div className="empty">写真をアップロードすると、ここに表示されます。</div>
        )}

        {layout.imageDataUrl && (
          <>
            <h3>写真の向き・表示</h3>
            <div className="row">
              <button className="btn secondary small" onClick={() => rotate(-90)}>⟲ 90°</button>
              <button className="btn secondary small" onClick={() => rotate(90)}>⟳ 90°</button>
              <button className="btn secondary small" onClick={() => rotate(-1)}>⟲ 1°</button>
              <button className="btn secondary small" onClick={() => rotate(1)}>⟳ 1°</button>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>向き（回転）: {layout.imageRotationDeg}°</label>
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={layout.imageRotationDeg}
                  onChange={(e) => patch({ imageRotationDeg: Number(e.target.value) })}
                />
              </div>
              <div className="field" style={{ width: 160 }}>
                <label>背景の透過度: {(layout.imageOpacity * 100) | 0}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={layout.imageOpacity}
                  onChange={(e) => patch({ imageOpacity: Number(e.target.value) })}
                />
              </div>
            </div>

            <h3>スケール校正</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "calibrate" ? "" : "secondary"}`}
                onClick={() => {
                  setMode(mode === "calibrate" ? "pan" : "calibrate");
                  setCalibPts([]);
                }}
              >
                {mode === "calibrate" ? "基準線：2点をクリック中…" : "基準寸法を設定"}
              </button>
              {layout.calibration && (
                <button className="btn secondary small" onClick={() => patch({ calibration: null })}>
                  校正クリア
                </button>
              )}
              <span className="hint">
                既知の長さ（パネル1枚の実寸や敷地の一辺）の両端をクリック→実長(m)を入力
              </span>
            </div>

            <h3>流用パネルの指定（変更しないパネル）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "select" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "select" ? "pan" : "select")}
              >
                {mode === "select" ? "選択中：パネルをクリックで切替" : "流用/入換を指定"}
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(true)}>
                全部を流用
              </button>
              <button className="btn secondary small" onClick={() => setAllPlant(false)}>
                全部を入換
              </button>
              <span className="hint">
                <span style={{ color: KEEP_COLOR }}>■</span> 緑＝流用（変更しない）／ その他＝入換対象。
                指定モードで個別パネルをクリックして切替。
              </span>
            </div>

            <h3>パネルの撤去（フェンス離隔など）</h3>
            <div className="row">
              <button
                className={`btn small ${mode === "remove" ? "" : "secondary"}`}
                onClick={() => setMode(mode === "remove" ? "pan" : "remove")}
              >
                {mode === "remove" ? "撤去モード：パネルをクリックで撤去/復活" : "パネルを撤去/復活"}
              </button>
              <span className="hint">
                クリックでそのパネルを取り外し（破線の空き枠）。もう一度で復活。撤去分は枚数から除外。
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
        )}
      </div>

      {layout.imageDataUrl && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", cursor: mode === "pan" ? "grab" : "crosshair" }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            onWheel={onWheel}
          />
          <div className="hint" style={{ padding: "6px 12px" }}>
            ドラッグ＝移動／ホイール＝ズーム／配列をドラッグで位置調整
          </div>
        </div>
      )}

      {layout.imageDataUrl && (
        <div className="card">
          <h2>パネル配列の配置</h2>
          {panels.length === 0 ? (
            <div className="empty">先に「パネル登録」でパネルを登録してください。</div>
          ) : (
            <div className="form-grid">
              <div className="field">
                <label>パネル</label>
                <select value={formPanelId} onChange={(e) => setFormPanelId(e.target.value)}>
                  {panels.map((p) => (
                    <option key={p.id} value={p.id}>{p.maker} {p.model}</option>
                  ))}
                </select>
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
                <input type="number" min={1} value={formRows} onChange={(e) => setFormRows(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>列数（横）</label>
                <input type="number" min={1} value={formCols} onChange={(e) => setFormCols(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>パネル間隔 (m)</label>
                <input type="number" step={0.01} value={formGap} onChange={(e) => setFormGap(Number(e.target.value))} />
              </div>
              <div className="field" style={{ justifyContent: "flex-end" }}>
                <button className="btn" onClick={addArray}>配列を追加</button>
              </div>
            </div>
          )}

          {panels.length > 0 && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn secondary" onClick={addFreePanel}>＋ 1枚追加（単独パネル）</button>
              <span className="hint">
                上の「パネル」「向き」で1枚だけ追加。ドラッグで移動・選択して回転/向き変更。
                端の増設や、横置きの中に縦置きを混ぜる用。
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
                  <input type="range" min={-90} max={90} value={selectedFree.rotationDeg} onChange={(e) => updateFree(selectedFree.id, { rotationDeg: Number(e.target.value) })} />
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
                  const p = panels.find((x) => x.id === a.panelId);
                  return (
                    <tr
                      key={a.id}
                      style={{ outline: a.id === selectedId ? "1px solid #fff" : undefined, cursor: "pointer" }}
                      onClick={() => setSelectedId(a.id)}
                    >
                      <td>
                        <span style={{ color: a.color }}>■</span> 配列{i + 1}
                        <div className="hint">{p?.model ?? "—"}</div>
                      </td>
                      <td className="num">{a.rows}×{a.cols}</td>
                      <td className="num">
                        {a.rows * a.cols}
                        {(a.keepCells?.length ?? 0) > 0 && (
                          <span className="hint"> (流用{a.keepCells!.length})</span>
                        )}
                      </td>
                      <td>{a.orientation === "portrait" ? "縦" : "横"}</td>
                      <td className="num">
                        <button className="btn danger small" onClick={(e) => { e.stopPropagation(); deleteArray(a.id); }}>削除</button>
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
                <div className="field">
                  <label>行数</label>
                  <input type="number" min={1} value={selected.rows} onChange={(e) => updateArray(selected.id, { rows: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>列数</label>
                  <input type="number" min={1} value={selected.cols} onChange={(e) => updateArray(selected.id, { cols: Number(e.target.value) })} />
                </div>
                <div className="field" style={{ flex: 1, minWidth: 200 }}>
                  <label>配列の回転: {selected.rotationDeg}°</label>
                  <input type="range" min={-45} max={45} value={selected.rotationDeg} onChange={(e) => updateArray(selected.id, { rotationDeg: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>向き</label>
                  <select value={selected.orientation} onChange={(e) => updateArray(selected.id, { orientation: e.target.value as "portrait" | "landscape" })}>
                    <option value="portrait">縦置き</option>
                    <option value="landscape">横置き</option>
                  </select>
                </div>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <span className="hint">この配列の流用指定：</span>
                <button className="btn secondary small" onClick={() => setAllCells(selected.id, true)}>全部流用</button>
                <button className="btn secondary small" onClick={() => setAllCells(selected.id, false)}>全部入換</button>
                <button className="btn secondary small" onClick={() => invertCells(selected.id)}>反転</button>
                <span className="hint">流用 {selected.keepCells?.length ?? 0} 枚</span>
              </div>
            </div>
          )}
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
