import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk } from "next/font/google";
import { UiLabelsProvider } from "@optipeople/ui";
import { BrandStripe } from "@optipeople/ui/blocks";
import { UI_LABELS, UI_LOCALE } from "@/lib/ui-labels";
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
        <UiLabelsProvider locale={UI_LOCALE} labels={UI_LABELS}>
          <div className="flex min-h-full flex-col overflow-x-hidden bg-[var(--color-background)]">
            {children}
            <BrandStripe />
          </div>
        </UiLabelsProvider>
      </body>
    </html>
  );
}
