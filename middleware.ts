import { NextResponse } from "next/server";

const USER = "QOa$Kuf0cHisDzIZmhlB"; // 好きなIDに変更可
const PASS = "fhp%1svirCuOMgXoJkUt"; // 好きなパスワードに変更可

function decodeBasicAuth(authHeader: string): { user: string; pass: string } | null {
  const [scheme, encoded] = authHeader.split(" ");
  if (scheme !== "Basic" || !encoded) return null;

  // Try atob first (Edge/Web), then fallback to a small base64 decoder (in case atob is unavailable).
  let decoded = "";
  try {
    if (typeof (globalThis as any).atob === "function") {
      decoded = (globalThis as any).atob(encoded);
    } else {
      decoded = decodeBase64(encoded);
    }
  } catch {
    return null;
  }

  const idx = decoded.indexOf(":");
  if (idx === -1) return null;

  return {
    user: decoded.slice(0, idx),
    pass: decoded.slice(idx + 1),
  };
}

// Minimal base64 decoder -> UTF-8 string (only used if atob is unavailable)
function decodeBase64(b64: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/\s+/g, "").replace(/=+$/, "");
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    const v = chars.indexOf(c);
    if (v === -1) continue;
    bits = (bits << 6) | v;
    bitCount += 6;

    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function middleware(req: Request) {
  const auth = req.headers.get("authorization");
  const creds = auth ? decodeBasicAuth(auth) : null;

  if (creds && creds.user === USER && creds.pass === PASS) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      // Add charset to avoid weird decoding issues on some clients
      "WWW-Authenticate": 'Basic realm="AI-Stamp", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: [
    // Exclude Next.js static assets and PWA files (prevents auth loops / broken startup in some clients)
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon-192.png|icon-512.png).*)",
  ],
};
