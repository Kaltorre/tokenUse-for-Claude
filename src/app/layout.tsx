import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "tockenUsageC — Claude Token Usage Monitor",
  description: "Real-time Claude Code token usage analytics dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pl" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem("theme");if(t==="light")document.documentElement.classList.add("light")})();`,
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
