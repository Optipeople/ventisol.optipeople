import type { Metadata } from "next";
import { AuthScreen } from "@optipeople/ui/blocks";
import { ForgotPasswordForm } from "@/app/forgot-password/forgot-form";

export const metadata: Metadata = { title: "Nulstil din adgangskode" };

const AUTH_FOOTER_LINKS = [
  {
    label: "Handelsbetingelser",
    href: "https://optipeople.com/terms-and-conditions/",
  },
];

export default function ForgotPasswordPage() {
  return (
    <AuthScreen footerLinks={AUTH_FOOTER_LINKS}>
      <ForgotPasswordForm />
    </AuthScreen>
  );
}
