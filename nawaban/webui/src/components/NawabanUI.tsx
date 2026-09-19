import { t as tr, useLocale } from "@/i18n";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Toast,
  ToastClose,
  ToastContent,
  ToastDescription,
  ToastPortal,
  ToastProvider,
  ToastTitle,
  ToastViewport,
  useToastManager,
} from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { NoticeCard, type NoticeStatus } from "@/components/application/notification/notice-card";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { cn } from "@/lib/utils";

// shadcn Dialog adapted to a side sheet; Base UI owns focus, dismissal and
// dialog semantics. The surface recipe (radius/3xl, full-height wide sheet)
// stays in styles/index.css via .nawaban-modal.
export function NawabanDialog({
  open,
  onClose,
  title,
  children,
  wide = false,
  header,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  header?: ReactNode;
}) {
  useLocale();
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        aria-label={title}
        showCloseButton={false}
        className={cn(
          // .nawaban-modal owns width/radius/border; shadcn's max-width cap
          // and hairline ring have to be cleared for it to take effect.
          "nawaban-modal max-w-none p-0 ring-0 sm:max-w-none",
          // The wide variant is a right-anchored, full-height sheet rather
          // than shadcn's centred modal.
          wide && "nawaban-modal-wide top-0 left-auto right-0 translate-x-0 translate-y-0",
        )}
      >
        <div className="nawaban-dialog">
          <header className="dialog-heading">
            {header ?? <DialogTitle className="text-headline-medium">{title}</DialogTitle>}
            <DialogClose
              aria-label={tr("close")}
              render={<Button variant="ghost" size="icon-xs" className="rounded-full bg-background-tertiary-default text-foreground-icon-secondary" />}
            >
              <CloseGlyph />
            </DialogClose>
          </header>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 12.6 12.6" className="size-[12.6px]" fill="none" aria-hidden>
      <path d="M2 2L10.6 10.6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M10.6 2L2 10.6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function Surface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  useLocale();
  return (
    <SettingsCard className={cn("nawaban-surface", className)}>
      {children}
    </SettingsCard>
  );
}

// Layout-only composition of the shadcn button, used for navigable task content.
// The inner span is load-bearing: .content-button > span rules in index.css
// lay the label out, and shadcn's Button renders children unwrapped.
export function ContentButton({ className, children, ...props }: ComponentProps<typeof Button>) {
  useLocale();
  return (
    <Button
      variant="ghost"
      size="lg"
      {...props}
      className={cn("content-button border-0", className)}
    >
      <span>{children}</span>
    </Button>
  );
}

const NoticeContext = createContext<
  (title: string, status?: NoticeStatus, description?: string) => void
>(() => {});
export const useNotice = () => useContext(NoticeContext);
export function Notices({ children }: { children: ReactNode }) {
  useLocale();
  return <ToastProvider timeout={5000} limit={1}><NoticeContents>{children}</NoticeContents></ToastProvider>;
}
function NoticeContents({ children }: { children: ReactNode }) {
  useLocale();
  const manager = useToastManager<{ status: NoticeStatus }>();
  return (
    <NoticeContext.Provider value={(title, status = "information", description) => {
      manager.add({ id: "nawaban-notice", title, description, data: { status }, priority: status === "error" ? "high" : "low" });
    }}>
      {children}
      <ToastPortal>
        <ToastViewport aria-label={tr("noticeRegion")} className="pointer-events-none fixed right-3 bottom-3 bui-toast-layer w-[min(400px,calc(100vw-24px))] sm:right-6 sm:bottom-6">
          {manager.toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} className="pointer-events-auto border-0 bg-transparent p-0 shadow-none">
              <ToastContent className="p-0">
                <NoticeCard
                  role="presentation"
                  className="pr-11"
                  status={toast.data?.status}
                  title={<ToastTitle render={<span />} />}
                  description={toast.description ? <ToastDescription render={<span />} /> : undefined}
                />
              </ToastContent>
              <ToastClose
                aria-label={tr("closeNotice")}
                className="absolute top-3 right-3"
                render={<Button variant="ghost" size="icon-xs" className="rounded-full bg-background-tertiary-default text-foreground-icon-secondary" />}
              >
                <CloseGlyph />
              </ToastClose>
            </Toast>
          ))}
        </ToastViewport>
      </ToastPortal>
    </NoticeContext.Provider>
  );
}

export function LoadState({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  useLocale();
  return (
    <div className="load-state">
      <NoticeCard
        title={error ? tr("loadFailed") : tr("workspace")}
        description={children}
        status={error ? "error" : "information"}
      />
    </div>
  );
}
