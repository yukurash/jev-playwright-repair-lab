import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import dataset from "../../../data/public/results.json";
import { App, DataError } from "./App";
import { parseDataset } from "./data";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
try {
  const parsed = parseDataset(dataset);
  root.render(<StrictMode><App dataset={parsed} /></StrictMode>);
} catch (error) {
  root.render(<DataError message={error instanceof Error ? error.message : "公開データを読み込めませんでした。"} />);
}
