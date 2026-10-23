import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ResetPasswordForm } from "@/app/reset-password/reset-form";

export const metadata: Metadata = { title: "Vælg en ny adgangskode" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const first = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v;

  // The reset email links back with token + email as query params. Accept
  // the casing variants the backend has been seen to use (as vola does).
  const token =
    first(params.token) ?? first(params.Token) ?? first(params.code) ?? "";
  const email =
    first(params.email) ?? first(params.Email) ?? first(params.user) ?? "";

  return (
    <AuthScreen>
      <ResetPasswordForm token={token} email={email} />
    </AuthScreen>
  );
}
