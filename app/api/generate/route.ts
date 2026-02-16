import { NextRequest, NextResponse } from "next/server";
import { PNG } from "pngjs";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";

// Batch mode is enabled by default for v4.
// Set OPENAI_USE_BATCH=0 to fall back to direct /v1/images/generations.
const USE_BATCH = (process.env.OPENAI_USE_BATCH ?? "1") !== "0";

// Default to low for high-throughput batch generation.
const IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || "low") as
  | "low"
  | "medium"
  | "high"
  | "auto";

const BATCH_POLL_TIMEOUT_MS = Number(
  process.env.OPENAI_BATCH_POLL_TIMEOUT_MS || 25_000
);
const BATCH_POLL_INTERVAL_MS = Number(
  process.env.OPENAI_BATCH_POLL_INTERVAL_MS || 2_000
);

async function openaiFetch(path: string, init?: RequestInit) {
  return fetch(`https://api.openai.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      ...(init?.headers || {}),
    },
  });
}

async function createSingleImageBatch(body: any) {
  // 1) Create a JSONL file with a single request.
  const customId = `gen-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jsonlLine =
    JSON.stringify({
      custom_id: customId,
      method: "POST",
      url: "/v1/images/generations",
      body,
    }) + "\n";

  const form = new FormData();
  form.append("purpose", "batch");
  form.append(
    "file",
    new Blob([jsonlLine], { type: "application/jsonl" }),
    "input.jsonl"
  );

  const upRes = await openaiFetch("/v1/files", {
    method: "POST",
    body: form,
  });
  if (!upRes.ok) {
    const t = await upRes.text();
    throw new Error(
      `OpenAI file upload failed (${upRes.status}): ${t.slice(0, 200)}`
    );
  }
  const up = (await upRes.json()) as { id: string };

  // 2) Create the batch.
  const batchRes = await openaiFetch("/v1/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input_file_id: up.id,
      endpoint: "/v1/images/generations",
      completion_window: "24h",
    }),
  });
  if (!batchRes.ok) {
    const t = await batchRes.text();
    throw new Error(
      `OpenAI batch create failed (${batchRes.status}): ${t.slice(0, 200)}`
    );
  }
  const batch = (await batchRes.json()) as { id: string };
  return { batch_id: batch.id, custom_id: customId };
}

async function tryGetBatchResultImageBase64(batchId: string, customId: string) {
  const stRes = await openaiFetch(`/v1/batches/${batchId}`);
  if (!stRes.ok) {
    const t = await stRes.text();
    throw new Error(
      `OpenAI batch status failed (${stRes.status}): ${t.slice(0, 200)}`
    );
  }
  const st = (await stRes.json()) as {
    status: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
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
    throw new Error(
      `OpenAI batch output fetch failed (${outRes.status}): ${t.slice(0, 200)}`
    );
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
      // ignore parse errors
    }
  }
  throw new Error("Batch completed but no matching image result was found.");
}

const OUTPUT_WIDTH = 370;
const OUTPUT_HEIGHT = 320;

function resizeContainBilinear(srcPng: PNG, dstW: number, dstH: number): Buffer {
  const srcW = srcPng.width;
  const srcH = srcPng.height;

  // contain
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
      // dst -> src inverse map
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

  // Make the character/text interior fully opaque while preserving outer anti-aliased edges.
  // Also fill any accidental transparency holes inside the sticker silhouette.
  const KEEP_EDGE_PX = 2;
  const dist = new Int16Array(size);
  dist.fill(-1);

  const q = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const alphaAt = (p: number) => data[p * 4 + 3];

  // Fill fully transparent holes that are enclosed by the sticker/character.
  // (Transparent pixels connected to the canvas border are treated as true background.)
  // This prevents accidental transparency inside characters (e.g., mochi body/head).
  {
    const bg = new Uint8Array(size); // 1 if background-connected transparent pixel
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

    // Seed from border pixels.
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

    // Any remaining alpha==0 pixel that is not background-connected is a hole; fill it.
    for (let p = 0; p < size; p++) {
      if (alphaAt(p) !== 0) continue;
      if (bg[p]) continue;
      data[p * 4 + 0] = 255;
      data[p * 4 + 1] = 255;
      data[p * 4 + 2] = 255;
      data[p * 4 + 3] = 255;
    }
  }

  // Edge pixels: alpha>0 with any neighbor alpha==0 (transparent background).
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

  // BFS distance from the edge into the opaque region.
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

  // Clamp interior alpha to fully opaque.
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


export async function GET(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(req.url);
    const message = searchParams.get("message") ?? "";
    const keyword = searchParams.get("keyword") ?? "";

    const text =
      message.trim().length > 0 ? message.trim() : "PayPay銀行へ入金よろしく";
    const theme =
      keyword.trim().length > 0 ? keyword.trim() : "麦色の毛の猫";
    const isMochi = /餅|もち|mochi/i.test(theme);
    const mochiConstraints: string[] = isMochi
      ? [
          "For a mochi (rice cake) character: render the body as pure opaque white, soft and slightly squishy, smooth with a subtle powdery texture.",
          "ABSOLUTE: Paint the mochi boy's entire body AND head with pure white (#FFFFFF) in fully opaque color (alpha=255). Never leave any holes or see-through areas.",
          "No stripes, no banding, no wrappers, no plates, no packaging, and no toppings/fillings unless explicitly requested.",
          "Keep the body shape as a simple rounded mochi blob. Shading must be very subtle (no large gray panels).",
        ]
      : [];


    const complianceGuidelines: string[] = [
      "IMPORTANT: Do not depict, imitate, or reference any third-party copyrighted/trademarked characters, logos, brands, or recognizable IP. All characters and designs must be original.",
      "Do not include URLs, release announcements, or calls-to-action in the artwork text.",
      "Keep the sticker appropriate for general audiences: no nudity, no explicit sexual content, no extreme violence, no self-harm, no illegal drugs, and no hate/harassment.",
      "",
      "[Guidelines (must be followed to avoid rejection)]",
      "1. Images (sticker images, main image, chat room tab image)",
      "1.1. Items that do not conform to the format specified by the platform/company",
      "1.2. Items that are not suitable for conversation/communication",
      "1.3. Poor visibility (e.g., extremely wide images, full-body 8-head-tall characters, etc.)",
      "1.4. Stickers with a severely unbalanced overall composition (e.g., only pale colors, mere strings of numbers, etc.)",
      "1.5. Logo-only designs",
      "1.6. Images consisting of only simple text",
      "1.7. Text inside the sticker contains mistakes/typos",
      "1.8. Contradicts the description or title",
      "1.9. Main image/tab image that is significantly different from the stickers being sold",
      "1.10. Duplicates of stickers already sold or already submitted/reviewed in the sticker shop",
      "",
      "2. Text (sticker title, product description, creator name, copyright)",
      "2.1. Items that do not conform to the format specified by the platform/company",
      "2.2. Text contains mistakes/typos",
      "2.3. Titles/descriptions containing announcement copy (e.g., \"Scheduled for release on [date]\", \"Search for [keyword]\", etc.)",
      "2.4. URLs are shown",
      "2.5. Emoji (e.g., hearts) or platform/device-dependent characters are included",
      "2.6. Extremely short text",
      "2.7. Contradicts the sticker images",
      "",
      "3. Morals",
      "3.1. Promotes or encourages crime",
      "3.2. Depicts violence, child abuse, or child pornography",
      "3.3. Excessive skin exposure",
      "3.4. Promotes excessive alcohol consumption, illegal drugs, or alcohol/tobacco consumption by minors",
      "3.5. Encourages drunk driving",
      "3.6. Realistic depictions of illegal weapons, or likely encourages their use",
      "3.7. Intended for phishing or spam",
      "3.8. Realistic depictions of killing or injuring people/animals (shot, stabbed, torture, etc.)",
      "3.9. Could defame, slander, or attack a specific individual, corporation, country, or group",
      "3.10. Discloses or may disclose personal information of others or oneself",
      "3.11. Excessively unpleasant or vulgar content",
      "3.12. Attacks religion, culture, ethnicity, nationality, or causes strong discomfort",
      "3.13. Religious solicitation/enlightenment, or overly strong religious elements",
      "3.14. Political expression or election-related content",
      "3.15. Designed to confuse or disgust users",
      "3.16. Sexual expression/content",
      "3.17. Encourages gambling or gambling-like activities",
      "3.18. Intended to obtain user passwords or private user data",
      "3.19. Could hinder healthy youth development (e.g., pachinko, horse racing, etc.)",
      "3.20. Induces or encourages suicide, self-harm, or drug abuse",
      "3.21. Induces or encourages bullying",
      "3.22. Promotes discrimination or may do so",
      "3.23. Other antisocial content or content that may offend others",
      "",
      "4. Business / Advertising / Other",
      "4.1. Requires providing personal information/ID in order to purchase the stickers",
      "4.2. Intended to provide (free or paid) to third parties beyond personal use (e.g., giving away stickers to visitors via a company campaign)",
      "4.3. Mentions the name of a messenger app (or similar service), or includes characters related to it",
      "4.4. Intended for commercial advertising/promotion for apps/services/companies (including recruiting/job postings, etc.)",
      "4.5. Solicits charity or donations",
      "4.6. Solicits membership or donations for political groups, religious groups, antisocial forces, or other organizations",
      "",
      "5. Rights / Laws",
      "5.1. Infringes or violates intellectual property rights (trademark, copyright, patents, design rights, etc.) of the platform or third parties, or violates third-party asset/license terms",
      "5.2. Rights ownership is unclear (e.g., derivative works/fan art, etc.)",
      "5.3. Infringes portrait rights or publicity rights (e.g., an unlicensed face/portrait, caricature, etc.)",
      "5.4. Cannot prove permission from the rights holder",
      "5.5. Otherwise violates applicable laws in the service region, or infringes third-party rights/interests",
    ];


    const frontPrompt = [
      "Generate a single LINE-style Japanese sticker illustration.",
      "Overall style: soft, cute, chibi-style character illustration.",
      "Do not make the illustration small and centered. Use the 370x320 canvas broadly and fill the available area.",
      "Make the Japanese text as large as possible while keeping it fully readable.",
      "The character (body, face, clothes, accessories) must be painted with solid, fully opaque colors.",
      "Do NOT make the character translucent or see-through: no glass, jelly, clear, ghost, watery, or low-opacity effects.",
      "If the character theme implies mochi/rice cake, still render it as fully opaque (no refraction, no see-through look).",
      "Only the background is transparent. The character and text must be fully opaque with no transparency holes.",
      "Make the character's reaction VERY exaggerated and over-the-top (big facial expression, big mouth, bold eyebrows, sweat drops/tears, motion lines).",
      "The text and the character must not be transparent. Only the background is transparent.",
      "The area inside the outline must not be transparent.",
      "ABSOLUTE: If the theme is \"らむちゃん\", NEVER draw any horns/antennae (no horns at all).",
      "ABSOLUTE RULE (NO EXCEPTIONS): The character, the Japanese text, and the white sticker backing must NEVER contain transparency. Alpha must be 255 (fully opaque) everywhere inside the sticker area.",
      "If you are unsure whether a pixel belongs to the character/text/backing or the background, make it OPAQUE (not transparent).",
      "Even if the character is pure white on a pure white sticker backing, keep it fully opaque and separate edges with a thin light-gray outline and/or a tiny soft shadow (both fully opaque). Do NOT erase white parts.",
      "Never use transparency for highlights, shading, glow, or sparkles on the character/text; render all effects as opaque colors.",
      "",
      "Character reference glossary (for interpreting the keyword/theme):",
      "• 『僕』: a cute chibi boy character whose body IS mochi (Japanese rice cake). Mochi is made from pounded glutinous rice and looks like a smooth, soft, slightly squishy, fully opaque white mass (NOT transparent). Keep it simple and rounded, like a mochi blob.",
      "• 『らむちゃん』: An ORIGINAL chibi woman character and MUST look NOTHING like any existing anime/manga character.",
      "  - NOT based on any existing anime/manga. Must NOT resemble any copyrighted/trademarked character in face, hair, outfit, accessories, or overall vibe.",
      "  - Age: 23. Gender: woman. Slightly chubby.",
      "  - Hair: brown with red mesh highlights.",
      "  - 『むぎちゃん』's owner; she adores and spoils 『むぎちゃん』. She works nights (adult/night job), but keep depiction non-explicit and wholesome: no nudity, no lingerie, no sexual content.",
      "• 『むぎちゃん』: a 7-month-old female cat/kitten with LIGHT wheat-colored fur (light wheat-colored fur), pale golden-beige. (NOT chestnut.)",
      ...complianceGuidelines,
      "The character must face straight toward the viewer. The pose must be strictly front-facing.",
      "Do not draw the character looking to the left or right. Do not use a three-quarter view or side view.",
      "Both eyes, both cheeks, and both shoulders should be visible and almost the same size, as in a true front view.",
      "Avoid any angle where only one eye appears much larger or the face is clearly turned to one side.",
      "The character's gaze should look directly at the viewer in the center of the image, not sideways or down.",
      "Do not draw turning, looking back, or showing the back of the body. The chest and torso should also face the viewer.",
      "Even if the character is moving (walking, running, etc.), keep the head and upper body facing straight forward.",
      "Treat any angle that is not clearly front-facing as incorrect. Front-facing orientation is the top priority.",
      "",
      "",
      "CRITICAL: Render the Japanese message EXACTLY as provided, character-for-character.",
      "No typos, no missing characters, no extra characters, no substitutions, and no paraphrasing.",
      "Prioritize text correctness over decoration. If needed, reduce sparkles/ornaments but keep the characters exact.",
      "SPECIAL CASE (HIGH PRIORITY): If the requested sticker text is exactly \"poi-!poi-!\", be extremely careful and render it PERFECTLY as \"poi-!poi-!\" (same letters, hyphen, and exclamation marks). Double-check for typos, missing symbols, or extra spaces.",
      "Make the Japanese text very large, thick, and bold so it stands out like a sticker.",
      "Give the text a strong outline and a slight 3D feeling so it remains easy to read even at small size.",
      "Make the Japanese text very flashy and sparkling in a 'kira-kira' LINE sticker style: use bright colors, thick colored outlines, soft neon-like glow, glitter-like sparkles, and small star or heart decorations around the letters.",
      "However, never sacrifice legibility: do not cover, distort, or break the shapes of any Japanese characters, and keep every character clearly readable even when the sticker is small.",
      "Keep the lettering rounded and friendly, like pop-style comic handwriting.",
      "",
      "Create a solid white sticker backing: cut out the combined silhouette of the character and the Japanese text, and fill that silhouette with pure white (fully opaque).",
      "When filling with pure white (fully opaque), carefully consider transparency vs opacity and make sure the filled area is truly opaque (no accidental transparency).",
      "Everything outside this white sticker backing must be fully transparent (alpha channel).",
      "Do not add any other background elements: no extra panels, shapes, gradients, or patterns beyond the white sticker backing.",
      "Ensure the entire character and the Japanese text are filled and fully opaque (no accidental transparency holes). You may anti-alias only the outer edges; the interior must remain opaque.",
    ].join("\n");

    const rightPrompt = [
      "Generate a single LINE-style Japanese sticker illustration.",
      "Overall style: soft, cute, chibi-style character illustration.",
      "Do not make the illustration small and centered. Use the 370x320 canvas broadly and fill the available area.",
      "Make the Japanese text as large as possible while keeping it fully readable.",
      "The character (body, face, clothes, accessories) must be painted with solid, fully opaque colors.",
      "Do NOT make the character translucent or see-through: no glass, jelly, clear, ghost, watery, or low-opacity effects.",
      "If the character theme implies mochi/rice cake, still render it as fully opaque (no refraction, no see-through look).",
      "Only the background is transparent. The character and text must be fully opaque with no transparency holes.",
      "Make the character's reaction VERY exaggerated and over-the-top (big facial expression, big mouth, bold eyebrows, sweat drops/tears, motion lines).",
      "The text and the character must not be transparent. Only the background is transparent.",
      "The area inside the outline must not be transparent.",
      "ABSOLUTE: If the theme is \"らむちゃん\", NEVER draw any horns/antennae (no horns at all).",
      "ABSOLUTE RULE (NO EXCEPTIONS): The character, the Japanese text, and the white sticker backing must NEVER contain transparency. Alpha must be 255 (fully opaque) everywhere inside the sticker area.",
      "If you are unsure whether a pixel belongs to the character/text/backing or the background, make it OPAQUE (not transparent).",
      "Even if the character is pure white on a pure white sticker backing, keep it fully opaque and separate edges with a thin light-gray outline and/or a tiny soft shadow (both fully opaque). Do NOT erase white parts.",
      "Never use transparency for highlights, shading, glow, or sparkles on the character/text; render all effects as opaque colors.",
      "",
      "Character reference glossary (for interpreting the keyword/theme):",
      "• 『僕』: a cute chibi boy character whose body IS mochi (Japanese rice cake). Mochi is made from pounded glutinous rice and looks like a smooth, soft, slightly squishy, fully opaque white mass (NOT transparent). Keep it simple and rounded, like a mochi blob.",
      "• 『らむちゃん』: An ORIGINAL chibi woman character and MUST look NOTHING like any existing anime/manga character.",
      "  - NOT based on any existing anime/manga. Must NOT resemble any copyrighted/trademarked character in face, hair, outfit, accessories, or overall vibe.",
      "  - Age: 23. Gender: woman. Slightly chubby.",
      "  - Hair: brown with red mesh highlights.",
      "  - 『むぎちゃん』's owner; she adores and spoils 『むぎちゃん』. She works nights (adult/night job), but keep depiction non-explicit and wholesome: no nudity, no lingerie, no sexual content.",
      "• 『むぎちゃん』: a 7-month-old female cat/kitten with LIGHT wheat-colored fur (light wheat-colored fur), pale golden-beige. (NOT chestnut.)",
      ...complianceGuidelines,
      "The character must clearly face toward the right side of the image from the viewer's perspective.",
      "Place the character on the left half of the canvas, facing toward the right edge of the canvas.",
      "Draw the head and body turned to the right so that the character is looking toward the right, not toward the left.",
      "The nose and face direction should point to the right side. Do not point the face or gaze toward the left.",
      "Use a right-facing side or three-quarter view, where the back of the head is on the left and the face looks to the right.",
      "Avoid any pose where the character is front-facing or looking to the left. Treat left-facing or front-facing as incorrect.",
      "Do not draw the character walking, running, or reaching toward the left. Movements and gestures should be directed to the right.",
      "The character's eyes and body language should clearly show that they are addressing something on the right side of the image.",
      "",
      "",
      "CRITICAL: Render the Japanese message EXACTLY as provided, character-for-character.",
      "No typos, no missing characters, no extra characters, no substitutions, and no paraphrasing.",
      "Prioritize text correctness over decoration. If needed, reduce sparkles/ornaments but keep the characters exact.",
      "SPECIAL CASE (HIGH PRIORITY): If the requested sticker text is exactly \"poi-!poi-!\", be extremely careful and render it PERFECTLY as \"poi-!poi-!\" (same letters, hyphen, and exclamation marks). Double-check for typos, missing symbols, or extra spaces.",
      "Make the Japanese text very large, thick, and bold so it stands out like a sticker.",
      "Give the text a strong outline and a slight 3D feeling so it remains easy to read even at small size.",
      "Make the Japanese text very flashy and sparkling in a 'kira-kira' LINE sticker style: use bright colors, thick colored outlines, soft neon-like glow, glitter-like sparkles, and small star or heart decorations around the letters.",
      "However, never sacrifice legibility: do not cover, distort, or break the shapes of any Japanese characters, and keep every character clearly readable even when the sticker is small.",
      "Keep the lettering rounded and friendly, like pop-style comic handwriting.",
      "",
      "Create a solid white sticker backing: cut out the combined silhouette of the character and the Japanese text, and fill that silhouette with pure white (fully opaque).",
      "When filling with pure white (fully opaque), carefully consider transparency vs opacity and make sure the filled area is truly opaque (no accidental transparency).",
      "Everything outside this white sticker backing must be fully transparent (alpha channel).",
      "Do not add any other background elements: no extra panels, shapes, gradients, or patterns beyond the white sticker backing.",
      "Ensure the entire character and the Japanese text are filled and fully opaque (no accidental transparency holes). You may anti-alias only the outer edges; the interior must remain opaque.",
    ].join("\n");

    // Orientation is fixed to FREE 360° (random camera angle each generation)
const angles = [
  "front view",
  "three-quarter view (left)",
  "three-quarter view (right)",
  "profile view (left)",
  "profile view (right)",
  "rear three-quarter view",
  "back view (the character turns head to look at the camera)",
  "top-down view (bird's-eye)",
  "low angle from below (worm's-eye)",
  "high angle from above",
  "from directly above",
  "from directly below",
];
const angle = angles[Math.floor(Math.random() * angles.length)];

const free360Block = [
  "OVERRIDE ORIENTATION: Ignore any earlier fixed front/right view constraints.",
  "Camera angle is FREE 360° and must be RANDOM each generation.",
  `Random camera angle for this image: ${angle}.`,
  "The camera may be above, below, behind, or any direction around the subject.",
  "However, the character's eyes/gaze must look directly at the camera (the viewer).",
  "If the camera is behind/above/below, rotate the head/pose so the face is still visible and maintaining eye contact.",
].join("\n");

const variableBlock = [
  `Character theme: "${theme}".`,
  ...mochiConstraints,
  "",
  `Include the Japanese message "${text}" inside the illustration as part of the artwork.`,
].join("\n");

const prompt = [frontPrompt, free360Block, variableBlock]
  .filter(Boolean)
  .join("\n\n");

    const requestBody = {
      model: IMAGE_MODEL,
      prompt,
      size: "1024x1024",
      n: 1,
      background: "transparent",
      output_format: "png",
      quality: IMAGE_QUALITY,
    };

    let b64: string | undefined;

    if (USE_BATCH) {
      const { batch_id, custom_id } = await createSingleImageBatch(requestBody);

      const started = Date.now();
      while (Date.now() - started < BATCH_POLL_TIMEOUT_MS) {
        const r = await tryGetBatchResultImageBase64(batch_id, custom_id);
        if (r.done) {
          b64 = r.b64;
          break;
        }
        await new Promise((res) => setTimeout(res, BATCH_POLL_INTERVAL_MS));
      }

      if (!b64) {
        return NextResponse.json(
          {
            status: "pending",
            batch_id,
            custom_id,
          },
          { status: 202 }
        );
      }
    } else {
      const apiRes = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        console.error("OpenAI image error:", apiRes.status, errText);
        const snippet = errText.slice(0, 160);
        return NextResponse.json(
          { error: `OpenAI error (status ${apiRes.status}): ${snippet}` },
          { status: 500 }
        );
      }

      const data = (await apiRes.json()) as {
        data?: { b64_json?: string }[];
      };

      b64 = data.data?.[0]?.b64_json;
    }

    if (!b64) {
      console.error("No b64_json in OpenAI response");
      return NextResponse.json(
        { error: "No image data returned from API" },
        { status: 500 }
      );
    }

    let b64Fixed = b64;
    try {
      b64Fixed = makeInteriorOpaquePngBase64(b64);
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
      { error: "Unexpected server error in /api/generate" },
      { status: 500 }
    );
  }
}