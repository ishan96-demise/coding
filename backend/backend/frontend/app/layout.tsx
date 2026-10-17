import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fin Sentinels | Network Intelligence Terminal",
  description: "Explainable financial fraud network intelligence command center.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
