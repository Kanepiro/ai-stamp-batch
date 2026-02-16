"use client";

import { useRef, useState } from "react";

const OUTPUT_WIDTH = 370;
const OUTPUT_HEIGHT = 320; // 370 x 320 PNG (LINE static sticker max)

export default function Home() {
  const [message, setMessage] = useState("");
  const [keyword, setKeyword] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [batchInfo, setBatchInfo] = useState<
    | null
    | {
        batch_id: string;
        items: Array<{ custom_id: string; message: string; keyword: string }>
      }
  >(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchStatus, setBatchStatus] = useState("");
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canSave = !!imageUrl && !loading;

  async function handleGenerate() {
    setStatus("生成中…");
    setLoading(true);

    if (imageUrl && imageUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(imageUrl);
      } catch {}
    }

    setImageUrl(null);

    try {
      const params = new URLSearchParams({
        message: message ?? "",
        keyword: keyword ?? "",
      });

      const res = await fetch(`/api/generate?${params.toString()}`, {
        method: "GET",
      });

      // Batch mode: server may respond with 202 + {batch_id, custom_id}
      if (res.status === 202) {
        const body = (await res.json().catch(() => null)) as any;
        const batch_id = body?.batch_id as string | undefined;
        const custom_id = body?.custom_id as string | undefined;
        if (!batch_id || !custom_id) {
          setStatus("エラー: Batch 受付に失敗しました");
          return;
        }

        setStatus("Batch 実行中…");

        const pollStarted = Date.now();
        const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
        const POLL_INTERVAL_MS = 2000;

        while (Date.now() - pollStarted < POLL_TIMEOUT_MS) {
          const p = new URLSearchParams({ batch_id, custom_id });
          const rr = await fetch(`/api/batch?${p.toString()}`, { method: "GET" });

          if (rr.status === 202) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            continue;
          }

          if (!rr.ok) {
            const raw = await rr.text();
            console.error("Batch poll error raw:", raw);
            setStatus(`エラー: Batch 取得に失敗しました (status ${rr.status})`);
            return;
          }

          const blob = await rr.blob();
          const url = URL.createObjectURL(blob);
          setImageUrl(url);
          setStatus("生成完了");
          return;
        }

        setStatus("Batch が混雑中です。しばらく待ってから再度お試しください");
        return;
      }

      if (!res.ok) {
        const raw = await res.text();
        console.error("Generate error raw:", raw);
        let msg = `生成に失敗しました (status ${res.status})`;
        if (raw) {
          try {
            const body = JSON.parse(raw);
            if (body && typeof (body as any).error === "string") {
              msg = `エラー: ${(body as any).error}`;
            } else {
              msg = msg + ": " + raw.slice(0, 80);
            }
          } catch {
            msg = msg + ": " + raw.slice(0, 80);
          }
        }
        setStatus(msg);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      setImageUrl(url);
      setStatus("生成完了");
    } catch (e) {
      console.error(e);
      setStatus("エラーが発生しました");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!imageUrl) return;
    setStatus("保存用画像を作成中…");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load failed"));
    });

    const canvas = canvasRef.current || (canvasRef.current = document.createElement("canvas"));
    const width = OUTPUT_WIDTH;
    const height = OUTPUT_HEIGHT;
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setStatus("エラー: canvas が利用できません");
      return;
    }

    // 透過背景のまま出力する（canvas はデフォルトで透明）
    ctx.clearRect(0, 0, width, height);

    // 元画像を縦横比維持で 370×320 内にフィットさせる
    const srcW = img.width;
    const srcH = img.height;
    const scale = Math.min(width / srcW, height / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const dx = (width - drawW) / 2;
    const dy = (height - drawH) / 2;

    ctx.drawImage(img, dx, dy, drawW, drawH);

    const pngData = canvas.toDataURL("image/png");

    // 保存ファイル名を 01.png, 02.png... の連番にする
    let seq = 1;
    try {
      const key = "ai-stamp-download-seq";
      const prev = Number(localStorage.getItem(key) || "0");
      seq = Number.isFinite(prev) ? prev + 1 : 1;
      localStorage.setItem(key, String(seq));
    } catch {
      // localStorage が使えない場合は 01.png
      seq = 1;
    }
    const filename = `${String(seq).padStart(2, "0")}.png`;

    const a = document.createElement("a");
    a.href = pngData;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setStatus(`保存しました（${width}×${height}）`);
  }

  function parseCsv(text: string): Array<{ message: string; keyword: string }> {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let inQuotes = false;

    const pushField = () => {
      cur.push(field);
      field = "";
    };
    const pushRow = () => {
      if (cur.length === 1 && cur[0].trim() === "") {
        cur = [];
        return;
      }
      rows.push(cur);
      cur = [];
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          const next = text[i + 1];
          if (next === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        pushField();
        continue;
      }
      if (ch === "\n") {
        pushField();
        pushRow();
        continue;
      }
      if (ch === "\r") {
        continue;
      }
      field += ch;
    }
    pushField();
    if (cur.length) pushRow();

    const norm = (s: string) => s.trim().toLowerCase();
    const header = rows[0] || [];
    const hasHeader = header.some((c) => ["message", "text", "msg"].includes(norm(c)));
    let msgIdx = 0;
    let keyIdx = 1;
    let start = 0;
    if (hasHeader) {
      start = 1;
      msgIdx = header.findIndex((c) => ["message", "text", "msg"].includes(norm(c)));
      keyIdx = header.findIndex((c) => ["keyword", "theme", "k"].includes(norm(c)));
      if (msgIdx < 0) msgIdx = 0;
      if (keyIdx < 0) keyIdx = 1;
    }

    const out: Array<{ message: string; keyword: string }> = [];
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const m = (row[msgIdx] ?? "").trim();
      const k = (row[keyIdx] ?? "").trim();
      if (!m) continue;
      out.push({ message: m, keyword: k });
    }
    return out;
  }

  async function handleCsvUpload(file: File) {
    setBatchStatus("CSV 読み込み中…");
    setBatchLoading(true);
    setBatchInfo(null);
    setBatchProgress(null);
    try {
      const csvText = await file.text();
      const rows = parseCsv(csvText);
      if (rows.length === 0) {
        setBatchStatus("エラー: CSV に有効な行がありません（message列が空の可能性）");
        return;
      }
      const items = rows.map((r) => ({ message: r.message, keyword: (r.keyword || keyword || "").trim() }));

      setBatchStatus(`Batch 送信中…（${items.length}件）`);

      const form = new FormData();
      const payload = new Blob([JSON.stringify({ items })], { type: "application/json" });
      form.append("payload", payload, "payload.json");

      const res = await fetch("/api/batch-csv", { method: "POST", body: form });
      if (!res.ok) {
        const raw = await res.text();
        console.error("batch-csv error raw:", raw);
        setBatchStatus(`エラー: Batch 作成に失敗しました (status ${res.status})`);
        return;
      }
      const body = (await res.json()) as any;
      const batch_id = body?.batch_id as string | undefined;
      const outItems = body?.items as Array<{ custom_id: string; message: string; keyword: string }> | undefined;
      if (!batch_id || !Array.isArray(outItems) || outItems.length === 0) {
        setBatchStatus("エラー: Batch 作成レスポンスが不正です");
        return;
      }
      setBatchInfo({ batch_id, items: outItems });
      setBatchStatus(`Batch 受付完了: ${batch_id}`);
    } catch (e) {
      console.error(e);
      setBatchStatus("エラーが発生しました");
    } finally {
      setBatchLoading(false);
    }
  }

  async function handleBatchDownloadAll() {
    if (!batchInfo) return;
    setBatchLoading(true);
    setBatchStatus("Batch 結果を取得中…");
    setBatchProgress({ done: 0, total: batchInfo.items.length });

    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 30 * 60 * 1000;
    const start = Date.now();
    let idx = 0;
    try {
      while (idx < batchInfo.items.length) {
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          setBatchStatus("タイムアウト: Batch が完了していない可能性があります");
          return;
        }

        const it = batchInfo.items[idx];
        const p = new URLSearchParams({ batch_id: batchInfo.batch_id, custom_id: it.custom_id });
        const rr = await fetch(`/api/batch?${p.toString()}`, { method: "GET" });

        if (rr.status === 202) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }
        if (!rr.ok) {
          const raw = await rr.text();
          console.error("batch download error raw:", raw);
          setBatchStatus(`エラー: 取得に失敗しました（${idx + 1}件目 / status ${rr.status}）`);
          return;
        }

        const blob = await rr.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${String(idx + 1).padStart(3, "0")}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        try {
          URL.revokeObjectURL(url);
        } catch {}

        idx++;
        setBatchProgress({ done: idx, total: batchInfo.items.length });
      }
      setBatchStatus("全部ダウンロード完了");
    } catch (e) {
      console.error(e);
      setBatchStatus("エラーが発生しました");
    } finally {
      setBatchLoading(false);
    }
  }

  return (
    <div className="app-root">
      <div className="card">
        <div className="header">
          <div className="title">AI-Stamp</div>
          <div className="version">v4.0.004</div>
        </div>

        <div className="row">
          <label>Message</label>
          <input
            maxLength={20}
            placeholder="PayPay銀行へ入金よろしく"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>

        <div className="row">
          <label>Keyword</label>
          <textarea
            rows={2}
            placeholder="麦色の毛の猫 など"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        <div className="preview">
          <div className="preview-inner">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageUrl} alt="preview" />
            ) : (
              <span style={{ fontSize: 12, color: "#bbb" }}>ここにプレビューが表示されます</span>
            )}
          </div>
        </div>

        <div style={{ fontSize: 10, color: "#999", textAlign: "right" }}>
          出力サイズ（保存）: {OUTPUT_WIDTH} × {OUTPUT_HEIGHT}
        </div>

        <div className="buttons">
          <button className="primary-btn" onClick={handleGenerate} disabled={loading}>
            {loading ? "生成中…" : "生成"}
          </button>
          <button
            className={`secondary-btn${canSave ? " save-enabled" : ""}`}
            onClick={handleSave}
            disabled={!canSave}
          >
            保存
          </button>
        </div>

        <div className="status">{status}</div>

        <div style={{ height: 16 }} />

        <div className="row">
          <label>CSV Batch</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={batchLoading}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void handleCsvUpload(f);
                e.currentTarget.value = "";
              }}
            />
            <button
              className="secondary-btn save-enabled"
              onClick={handleBatchDownloadAll}
              disabled={!batchInfo || batchLoading}
              title={!batchInfo ? "先にCSVを投入してください" : "Batch完了まで待ちつつ順次ダウンロード"}
            >
              {batchLoading ? "処理中…" : "全部ダウンロード"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#888", marginTop: 6, lineHeight: 1.4 }}>
            CSVは <code>message,keyword</code>（ヘッダー有/無どちらでも可）。keyword が空の行は上の
            Keyword を使用。
          </div>
        </div>

        <div className="status">{batchStatus}</div>
        {batchProgress ? (
          <div style={{ fontSize: 12, color: "#bbb", textAlign: "right" }}>
            {batchProgress.done} / {batchProgress.total}
          </div>
        ) : null}
      </div>
    </div>
  );
}
