import { createContext, useContext, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Toast } from "@base-ui/react/toast";
import {
  Notification,
  type NotificationStatus,
} from "@/components/base/notification/notification";
import { CloseButton } from "@/components/base/buttons/close-button";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { Button, type ButtonProps } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";

// BoardUI dialog surface adapted to a side sheet; Base UI owns focus,
// dismissal and dialog semantics. The source recipe remains radius/3xl + full surface.
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
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="nawaban-backdrop" />
        <Dialog.Viewport className={cx("nawaban-overlay", wide && "nawaban-overlay-sheet")}>
          <Dialog.Popup aria-label={title} className={cx("nawaban-modal", wide && "nawaban-modal-wide")}>
            <div className="nawaban-dialog">
              <header className="dialog-heading">
                {header ?? <Dialog.Title className="text-headline-medium">{title}</Dialog.Title>}
                <Dialog.Close render={<CloseButton size="sm" aria-label="关闭" />} />
              </header>
              {children}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Surface({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <SettingsCard className={cx("nawaban-surface", className)}>
      {children}
    </SettingsCard>
  );
}
// Layout-only composition of the BoardUI button, used for navigable task content.
export function ContentButton({ className, ...props }: ButtonProps) {
  return (
    <Button
      variant="ghost"
      {...props}
      className={cx("content-button", className)}
    />
  );
}
const NoticeContext = createContext<
  (title: string, status?: NotificationStatus, description?: string) => void
>(() => {});
export const useNotice = () => useContext(NoticeContext);
export function Notices({ children }: { children: ReactNode }) {
  return <Toast.Provider timeout={5000} limit={1}><NoticeContents>{children}</NoticeContents></Toast.Provider>;
}
function NoticeContents({ children }: { children: ReactNode }) {
  const manager = Toast.useToastManager<{ status: NotificationStatus }>();
  return (
    <NoticeContext.Provider value={(title, status = "information", description) => {
      manager.add({ id: "nawaban-notice", title, description, data: { status }, priority: status === "error" ? "high" : "low" });
    }}>
      {children}
      <Toast.Portal>
        <Toast.Viewport aria-label="通知" className="pointer-events-none fixed right-3 bottom-3 bui-toast-layer w-[min(400px,calc(100vw-24px))] sm:right-6 sm:bottom-6">
          {manager.toasts.map((toast) => (
            <Toast.Root key={toast.id} toast={toast} className="pointer-events-auto relative data-ending-style:opacity-0 transition-opacity duration-150">
              <Notification
                role="presentation"
                title={<Toast.Title render={<span />} />}
                description={toast.description ? <Toast.Description render={<span />} /> : undefined}
                status={toast.data?.status}
                dismissible={false}
              />
              <Toast.Close render={<CloseButton size="xs" aria-label="关闭通知" className="absolute top-3 right-3" />} />
            </Toast.Root>
          ))}
        </Toast.Viewport>
      </Toast.Portal>
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
  return (
    <div className="load-state">
      <Notification
        title={error ? "加载失败" : "工作空间"}
        description={children}
        status={error ? "error" : "information"}
      />
    </div>
  );
}
