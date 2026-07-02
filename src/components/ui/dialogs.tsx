// ============================================================
// アプリ共通のトースト／確認モーダル／入力モーダル（依存追加なし）
//   ネイティブ alert/confirm/prompt の置き換え先。
//   - useToast():   toast(msg, kind) — 右下に数秒表示して自動で消える
//   - useConfirm(): confirmDlg({...}) — OK/キャンセルの Promise<boolean>
//   - usePrompt():  promptDlg({...}) — 1行入力の Promise<string | null>
//   Provider は App のルート（key 再マウントの外）に置くこと。
//   ※ store.ts の保存失敗 alert は React 外＋データ消失警告のため対象外（native のまま）。
// ============================================================
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "info" | "warn" | "error";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

export interface ConfirmOptions {
  /** 本文（\n で改行可） */
  message: string;
  /** タイトル（省略時は「確認」） */
  title?: string;
  /** OKボタンの文言（省略時「OK」） */
  okLabel?: string;
  /** キャンセルボタンの文言（省略時「キャンセル」） */
  cancelLabel?: string;
  /** 削除系は true にすると OK ボタンが赤になる */
  danger?: boolean;
  /** お知らせ専用（キャンセルボタンを出さない。alert の代替） */
  hideCancel?: boolean;
}

export interface PromptOptions {
  /** 本文（\n で改行可） */
  message: string;
  title?: string;
  /** 初期値 */
  defaultValue?: string;
  /** 数値のみ受け付ける（空・非数・0以下はOK不可） */
  numeric?: boolean;
  okLabel?: string;
  placeholder?: string;
}

interface DialogContextValue {
  toast: (text: string, kind?: ToastKind) => void;
  confirmDlg: (opts: ConfirmOptions) => Promise<boolean>;
  promptDlg: (opts: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

/** 右下トースト。 */
export function useToast() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("DialogProvider が見つかりません（main.tsx で App を包んでください）");
  return ctx.toast;
}

/** 確認モーダル（confirm の代替）。Enter=OK / Escape=キャンセル。 */
export function useConfirm() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("DialogProvider が見つかりません（main.tsx で App を包んでください）");
  return ctx.confirmDlg;
}

/** 入力モーダル（prompt の代替）。 */
export function usePrompt() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("DialogProvider が見つかりません（main.tsx で App を包んでください）");
  return ctx.promptDlg;
}

interface ConfirmState extends ConfirmOptions {
  resolve: (v: boolean) => void;
}
interface PromptState extends PromptOptions {
  resolve: (v: string | null) => void;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  // ---- トースト ----
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, text, kind }]); // 溜まりすぎ防止（最大4件）
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  // ---- 確認モーダル ----
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const confirmDlg = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve }));
  }, []);
  const closeConfirm = (v: boolean) => {
    confirmState?.resolve(v);
    setConfirmState(null);
  };

  // ---- 入力モーダル ----
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const promptDlg = useCallback((opts: PromptOptions) => {
    setPromptValue(opts.defaultValue ?? "");
    return new Promise<string | null>((resolve) => setPromptState({ ...opts, resolve }));
  }, []);
  const promptOkDisabled =
    promptState?.numeric === true && !(Number.isFinite(Number(promptValue)) && promptValue.trim() !== "" && Number(promptValue) > 0);
  const closePrompt = (ok: boolean) => {
    promptState?.resolve(ok ? promptValue : null);
    setPromptState(null);
  };

  // ---- キーボード（Enter=OK / Escape=キャンセル）----
  useEffect(() => {
    if (!confirmState && !promptState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (promptState) closePrompt(false);
        else closeConfirm(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (promptState) {
          if (!promptOkDisabled) closePrompt(true);
        } else closeConfirm(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmState, promptState, promptValue, promptOkDisabled]);

  const modal = confirmState ?? promptState;

  return (
    <DialogContext.Provider value={{ toast, confirmDlg, promptDlg }}>
      {children}

      {/* モーダル（確認／入力） */}
      {modal && (
        <div className="dlg-overlay" onMouseDown={() => (promptState ? closePrompt(false) : closeConfirm(false))}>
          <div className="dlg-box" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="dlg-title">{modal.title ?? "確認"}</h3>
            <div className="dlg-message">{modal.message}</div>
            {promptState && (
              <input
                className="dlg-input"
                type={promptState.numeric ? "number" : "text"}
                value={promptValue}
                placeholder={promptState.placeholder}
                autoFocus
                onChange={(e) => setPromptValue(e.target.value)}
              />
            )}
            <div className="dlg-actions">
              {!confirmState?.hideCancel && (
                <button className="btn secondary" onClick={() => (promptState ? closePrompt(false) : closeConfirm(false))}>
                  {(confirmState?.cancelLabel) ?? "キャンセル"}
                </button>
              )}
              {promptState ? (
                <button className="btn" disabled={promptOkDisabled} onClick={() => closePrompt(true)}>
                  {promptState.okLabel ?? "OK"}
                </button>
              ) : (
                <button className={`btn ${confirmState?.danger ? "danger" : ""}`} autoFocus onClick={() => closeConfirm(true)}>
                  {confirmState?.okLabel ?? "OK"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* トースト（右下） */}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      )}
    </DialogContext.Provider>
  );
}
