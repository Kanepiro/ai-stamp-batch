import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
const IMAGE_QUALITY = (process.env.OPENAI_IMAGE_QUALITY || "low") as
  | "low"
  | "medium"
  | "high"
  | "auto";

async function openaiFetch(path: string, init?: RequestInit) {
  return fetch(`https://api.openai.com${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...(init?.headers || {}),
      },
    }
  );
}

function buildPrompt(text: string, theme: string) {
  // Keep this prompt intentionally lighter than /api/generate to make batch cheaper,
  // while preserving the critical "text must match" constraint.
  const t = (text || "").trim() || "PayPay銀行へ入金よろしく";
  const th = (theme || "").trim() || "麦色の毛の猫";

  const isMochi = /餅|もち|mochi/i.test(th);
  const mochi = isMochi
    ? [
        "For a mochi (rice cake) character: render the body as pure opaque white, soft and slightly squishy.",
        "ABSOLUTE: Paint the mochi character with pure white (#FFFFFF) and fully opaque color (alpha=255).",
        "No wrappers, plates, packaging, or toppings unless requested.",
      ]
    : [];

  return [
    "Generate a single LINE-style Japanese sticker illustration.",
    "Overall style: soft, cute, chibi-style character illustration.",
    "Use the 1024x1024 canvas broadly; make the composition big and readable.",
    "Background must be transparent.",
    "Create a solid white sticker backing with a thin light-gray outline; everything outside the backing is fully transparent.",
    "The character and Japanese text must be fully opaque (alpha=255). No translucency, no see-through.",
    "IMPORTANT: Do not depict or reference any third-party copyrighted/trademarked characters, logos, brands, or recognizable IP.",
    "CRITICAL: Render the Japanese message EXACTLY as provided, character-for-character. No typos. No missing or extra characters.",
    "If needed, reduce decorations to keep the characters exact and readable.",
    "Make the text very large, thick, and bold, like a typical flashy LINE sticker.",
    "",
    `Character theme: "${th}".`,
    ...mochi,
    `Include the Japanese message "${t}" inside the illustration as the ONLY text.`,
    "Do not add any other text.",
  ].join("\n");
}

export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const payloadFile = form.get("payload");
    if (!(payloadFile instanceof File)) {
      return NextResponse.json(
        { error: "Missing payload (multipart form field 'payload')." },
        { status: 400 }
      );
    }
    const payloadText = await payloadFile.text();
    const payload = JSON.parse(payloadText) as {
      items: Array<{ message: string; keyword?: string }>;
    };

    const itemsIn = Array.isArray(payload.items) ? payload.items : [];
    const items = itemsIn
      .map((x) => ({
        message: (x?.message ?? "").toString().trim(),
        keyword: (x?.keyword ?? "").toString().trim(),
      }))
      .filter((x) => x.message.length > 0);

    if (items.length === 0) {
      return NextResponse.json(
        { error: "No valid items in payload." },
        { status: 400 }
      );
    }

    const ts = Date.now();
    const outItems: Array<{ custom_id: string; message: string; keyword: string }> = [];
    const lines: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const custom_id = `csv-${ts}-${String(i + 1).padStart(4, "0")}`;
      const message = items[i].message;
      const keyword = items[i].keyword;

      const body = {
        model: IMAGE_MODEL,
        prompt: buildPrompt(message, keyword),
        size: "1024x1024",
        n: 1,
        background: "transparent",
        output_format: "png",
        quality: IMAGE_QUALITY,
      };

      lines.push(
        JSON.stringify({
          custom_id,
          method: "POST",
          url: "/v1/images/generations",
          body,
        })
      );

      outItems.push({ custom_id, message, keyword });
    }

    const jsonl = lines.join("\n") + "\n";

    // 1) Upload JSONL as a batch input file.
    const upForm = new FormData();
    upForm.append("purpose", "batch");
    upForm.append(
      "file",
      new Blob([jsonl], { type: "application/jsonl" }),
      "input.jsonl"
    );

    const upRes = await openaiFetch("/v1/files", { method: "POST", body: upForm });
    if (!upRes.ok) {
      const t = await upRes.text();
      return NextResponse.json(
        { error: `OpenAI file upload failed (${upRes.status}): ${t.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const up = (await upRes.json()) as { id: string };

    // 2) Create batch.
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
      return NextResponse.json(
        { error: `OpenAI batch create failed (${batchRes.status}): ${t.slice(0, 200)}` },
        { status: 502 }
      );
    }
    const batch = (await batchRes.json()) as { id: string };

    return NextResponse.json({ batch_id: batch.id, items: outItems }, { status: 200 });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json(
      { error: e?.message ? String(e.message) : "Unknown error" },
      { status: 500 }
    );
  }
}
