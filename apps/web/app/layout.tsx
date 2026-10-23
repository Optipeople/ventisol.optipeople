import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Ventisol: Rapporter", template: "Ventisol: %s" },
  description: "Tid pr. ordre, element og station for Ventisol, fra OptiCloud",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="da" className={`h-full ${hankenGrotesk.variable}`}>
      <body className="min-h-full">
        <div className="flex min-h-full flex-col overflow-x-hidden bg-[var(--color-background)]">
          {children}
          <div className="brand-stripe" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        </div>
      </body>
    </html>
  );
}
