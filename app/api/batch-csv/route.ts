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
  // v4.0.004: CSV batch must use the same long prompt as /api/generate.
  const t = (text || "").trim() || "PayPay銀行へ入金よろしく";
  const th = (theme || "").trim() || "麦色の毛の猫";

  const isMochi = /餅|もち|mochi/i.test(th);
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
    `Character theme: "${th}".`,
    ...mochiConstraints,
    "",
    `Include the Japanese message "${t}" inside the illustration as part of the artwork.`,
  ].join("\n");

  return [frontPrompt, free360Block, variableBlock].filter(Boolean).join("\n\n");
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
