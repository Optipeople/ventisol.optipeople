import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { LoginForm } from "@/app/login/login-form";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Log ind" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await getSession();
  if (session.status === "ok") redirect("/");

  const showForbidden = error === "forbidden" || session.status === "forbidden";

  return (
    <AuthScreen>
      <LoginForm
        initialError={
          showForbidden
            ? "Din Optipeople-bruger har ikke adgang til Ventisol. Log ind med en bruger på Ventisol-kontoen, eller kontakt Optipeople."
            : undefined
        }
      />
    </AuthScreen>
  );
}
