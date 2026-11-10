import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";

export function AppToasts({ children }: { children: ReactNode }) {
    return (
        <Toast.Provider timeout={10_000} limit={3}>
            {children}
            <ToastList />
        </Toast.Provider>
    );
}

function ToastList() {
    const { toasts } = Toast.useToastManager();
    return (
        <Toast.Portal>
            <Toast.Viewport className="app-toast-viewport">
                {toasts.map((toast) => (
                    <Toast.Root key={toast.id} toast={toast} className="app-toast surface-raised">
                        <span className="app-toast-icon" aria-hidden="true">
                            !
                        </span>
                        <Toast.Content className="min-w-0 flex-1">
                            <Toast.Title className="text-sm font-semibold" />
                            <Toast.Description className="mt-1 text-sm text-slate-600" />
                        </Toast.Content>
                        <Toast.Close aria-label="Dismiss notification" className="app-toast-close">
                            ×
                        </Toast.Close>
                    </Toast.Root>
                ))}
            </Toast.Viewport>
        </Toast.Portal>
    );
}
