import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DialogProvider } from "./components/ui/dialogs";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* トースト/確認モーダルの土台。候補切替の key 再マウントの外に置き、確認中も生き残らせる */}
    <DialogProvider>
      <App />
    </DialogProvider>
  </React.StrictMode>
);
