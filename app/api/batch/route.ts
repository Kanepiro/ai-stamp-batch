import { NextRequest, NextResponse } from "next/server";
import { PNG } from "pngjs";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OUTPUT_WIDTH = 370;
const OUTPUT_HEIGHT = 320;

async function openaiFetch(path: string, init?: RequestInit) {
  return fetch(`https://api.openai.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...(init?.headers || {}),
    },
  });
}

function resizeContainBilinear(srcPng: PNG, dstW: number, dstH: number): Buffer {
  const srcW = srcPng.width;
  const srcH = srcPng.height;

  const scale = Math.min(dstW / srcW, dstH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const offX = (dstW - drawW) / 2;
  const offY = (dstH - drawH) / 2;

  const dst = new PNG({ width: dstW, height: dstH });
  dst.data.fill(0);

  const srcData = srcPng.data;
  const dstData = dst.data;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = (x - offX) / scale;
      const sy = (y - offY) / scale;

      if (sx < 0 || sy < 0 || sx > srcW - 1 || sy > srcH - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = clamp(x0 + 1, 0, srcW - 1);
      const y1 = clamp(y0 + 1, 0, srcH - 1);

      const tx = sx - x0;
      const ty = sy - y0;

      const p00 = (y0 * srcW + x0) * 4;
      const p10 = (y0 * srcW + x1) * 4;
      const p01 = (y1 * srcW + x0) * 4;
      const p11 = (y1 * srcW + x1) * 4;

      const di = (y * dstW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const v00 = srcData[p00 + c];
        const v10 = srcData[p10 + c];
        const v01 = srcData[p01 + c];
        const v11 = srcData[p11 + c];

        const v0 = v00 * (1 - tx) + v10 * tx;
        const v1 = v01 * (1 - tx) + v11 * tx;
        const v = v0 * (1 - ty) + v1 * ty;

        dstData[di + c] = v | 0;
      }
    }
  }

  return PNG.sync.write(dst);
}

function makeInteriorOpaquePngBase64(b64: string): string {
  const input = Buffer.from(b64, "base64");
  const png = PNG.sync.read(input);

  const { width, height, data } = png;
  const size = width * height;

  const KEEP_EDGE_PX = 2;
  const dist = new Int16Array(size);
  dist.fill(-1);

  const q = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const alphaAt = (p: number) => data[p * 4 + 3];

  // Fill enclosed transparency holes.
  {
    const bg = new Uint8Array(size);
    const q2 = new Int32Array(size);
    let h2 = 0;
    let t2 = 0;

    const pushIfTransparent = (x: number, y: number) => {
      const p = y * width + x;
      if (alphaAt(p) !== 0) return;
      if (bg[p]) return;
      bg[p] = 1;
      q2[t2++] = p;
    };

    for (let x = 0; x < width; x++) {
      pushIfTransparent(x, 0);
      pushIfTransparent(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      pushIfTransparent(0, y);
      pushIfTransparent(width - 1, y);
    }

    while (h2 < t2) {
      const p = q2[h2++];
      const x = p % width;
      const y = (p / width) | 0;

      if (x > 0) pushIfTransparent(x - 1, y);
      if (x + 1 < width) pushIfTransparent(x + 1, y);
      if (y > 0) pushIfTransparent(x, y - 1);
      if (y + 1 < height) pushIfTransparent(x, y + 1);
    }

    for (let p = 0; p < size; p++) {
      if (alphaAt(p) !== 0) continue;
      if (bg[p]) continue;
      data[p * 4 + 0] = 255;
      data[p * 4 + 1] = 255;
      data[p * 4 + 2] = 255;
      data[p * 4 + 3] = 255;
    }
  }

  // Detect edge pixels.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (alphaAt(p) === 0) continue;

      let isEdge = false;
      for (let dy = -1; dy <= 1 && !isEdge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            isEdge = true;
            break;
          }
          const np = ny * width + nx;
          if (alphaAt(np) === 0) {
            isEdge = true;
            break;
          }
        }
      }

      if (isEdge) {
        dist[p] = 0;
        q[tail++] = p;
      }
    }
  }

  while (head < tail) {
    const p = q[head++];
    const x = p % width;
    const y = (p / width) | 0;
    const d = dist[p];

    const neigh = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];

    for (const [nx, ny] of neigh) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (alphaAt(np) === 0) continue;
      if (dist[np] !== -1) continue;
      dist[np] = d + 1;
      q[tail++] = np;
    }
  }

  for (let p = 0; p < size; p++) {
    const a = alphaAt(p);
    if (a === 0) continue;
    const d = dist[p];
    if (d > KEEP_EDGE_PX) {
      data[p * 4 + 3] = 255;
    }
  }

  const out = PNG.sync.write(png);
  return out.toString("base64");
}

async function tryGetBatchResultImageBase64(batchId: string, customId: string) {
  const stRes = await openaiFetch(`/v1/batches/${batchId}`);
  if (!stRes.ok) {
    const t = await stRes.text();
    throw new Error(`OpenAI batch status failed (${stRes.status}): ${t.slice(0, 200)}`);
  }
  const st = (await stRes.json()) as {
    status: string;
    output_file_id?: string | null;
  };

  if (st.status !== "completed") {
    return { done: false, status: st.status } as const;
  }

  const outId = st.output_file_id;
  if (!outId) {
    throw new Error("Batch completed but output_file_id is missing.");
  }
  const outRes = await openaiFetch(`/v1/files/${outId}/content`);
  if (!outRes.ok) {
    const t = await outRes.text();
    throw new Error(`OpenAI batch output fetch failed (${outRes.status}): ${t.slice(0, 200)}`);
  }
  const text = await outRes.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as any;
      if (obj.custom_id !== customId) continue;
      const b64 = obj?.response?.body?.data?.[0]?.b64_json;
      if (typeof b64 === "string" && b64.length > 0) {
        return { done: true, b64 } as const;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("Batch completed but no matching image result was found.");
}

export async function GET(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(req.url);
    const batchId = searchParams.get("batch_id") || "";
    const customId = searchParams.get("custom_id") || "";

    if (!batchId || !customId) {
      return NextResponse.json(
        { error: "batch_id and custom_id are required." },
        { status: 400 }
      );
    }

    const r = await tryGetBatchResultImageBase64(batchId, customId);
    if (!r.done) {
      return NextResponse.json(
        { status: "pending", batch_id: batchId, custom_id: customId },
        { status: 202 }
      );
    }

    let b64Fixed = r.b64;
    try {
      b64Fixed = makeInteriorOpaquePngBase64(r.b64);
    } catch (e) {
      console.warn("PNG post-process failed; returning original image", e);
    }

    const pngBuf = Buffer.from(b64Fixed, "base64");
    let outBuf: Buffer = pngBuf;
    try {
      const srcPng = PNG.sync.read(pngBuf);
      outBuf = resizeContainBilinear(srcPng, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    } catch (e) {
      console.warn("Resize failed; returning original image", e);
      outBuf = pngBuf;
    }

    return new NextResponse(outBuf, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Route handler error", error);
    return NextResponse.json(
      { error: "Unexpected server error in /api/batch" },
      { status: 500 }
    );
  }
}
