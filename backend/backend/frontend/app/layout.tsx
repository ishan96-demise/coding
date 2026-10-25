import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fin Sentinels | Financial activity in context",
  description: "A clear workspace for reviewing transaction activity and connected account signals.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
