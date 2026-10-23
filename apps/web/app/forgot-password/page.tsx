import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ForgotPasswordForm } from "@/app/forgot-password/forgot-form";

export const metadata: Metadata = { title: "Nulstil din adgangskode" };

export default function ForgotPasswordPage() {
  return (
    <AuthScreen>
      <ForgotPasswordForm />
    </AuthScreen>
  );
}
