import type { ComponentProps, CSSProperties } from "react";
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@synara/shared/desktopChrome";
import { SidebarProvider } from "./ui/sidebar";

const THREAD_SIDEBAR_DEFAULT_WIDTH = "18rem";

/** Local and remote content use the same shell surfaces and sidebar geometry. */
export function ChatShell(props: ComponentProps<typeof SidebarProvider>) {
  const open = props.controls?.open ?? props.open ?? props.defaultOpen ?? true;
  return (
    <SidebarProvider
      {...props}
      className="h-svh overflow-hidden bg-[var(--app-rail-shell-background)]"
      style={
        {
          "--app-top-strip-height": `${CHAT_SURFACE_HEADER_HEIGHT_PX}px`,
          // Codex's sidebar panel width. A width the user drags to is stored and wins.
          "--sidebar-width": THREAD_SIDEBAR_DEFAULT_WIDTH,
        } as CSSProperties
      }
      data-sidebar-side="left"
      data-sidebar-layout="rail"
      data-shell-sidebar-state={open ? "expanded" : "collapsed"}
    />
  );
}
