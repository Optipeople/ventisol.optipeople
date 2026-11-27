"use client";

import { useTransition, type ComponentProps } from "react";
import { UserMenu } from "@optipeople/ui/blocks";
import { logout } from "@/app/login/actions";

type Props = Omit<ComponentProps<typeof UserMenu>, "onLogout" | "logoutAction">;

/**
 * The header's user menu with a log out that works. UserMenu's `logoutAction`
 * (@optipeople/ui 0.5.1) closes the menu in the button's click handler, which
 * takes the form out of the page before the browser submits it, so nothing is
 * sent. Here the server action is called from `onLogout`, which does not need
 * the form.
 */
export function PortalUserMenu(props: Props) {
  const [, startTransition] = useTransition();
  return (
    <UserMenu
      {...props}
      onLogout={() => {
        startTransition(async () => {
          await logout();
        });
      }}
    />
  );
}
