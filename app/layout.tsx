import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AI-Stamp",
  description: "AIでLINEスタンプ風の画像を作るツール",
  manifest: "/manifest.webmanifest",
  themeColor: "#AABBE6",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
