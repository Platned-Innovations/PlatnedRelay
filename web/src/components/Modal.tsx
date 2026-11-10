import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { FormField, Spinner } from './ui';
import { toast } from './Toasts';

function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, active]);
}

function useBodyLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** When false, clicking the backdrop / Esc does not close (e.g. secret display). */
  dismissible?: boolean;
}) {
  useEscape(onClose, open && dismissible);
  useBodyLock(open);
  const downOnOverlay = useRef(false);
  if (!open) return null;
  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => (downOnOverlay.current = e.target === e.currentTarget)}
      onMouseUp={(e) => {
        if (dismissible && downOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
  headerExtra,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  headerExtra?: ReactNode;
}) {
  useEscape(onClose, open);
  useBodyLock(open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className={`drawer${wide ? ' drawer-lg' : ''}`} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <h2>{title}</h2>
          {headerExtra}
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/**
 * Confirmation dialog with optional reason field and typed confirmation.
 * `onConfirm` may be async; errors are toasted and the dialog stays open.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  requireText,
  withReason,
  reasonLabel = 'Reason (optional, recorded in audit log)',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  withReason?: boolean;
  reasonLabel?: string;
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTyped('');
      setReason('');
      setBusy(false);
    }
  }, [open]);
  const blocked = !!requireText && typed !== requireText;
  const submit = async () => {
    if (blocked || busy) return;
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      onClose={() => !busy && onClose()}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={blocked || busy} onClick={submit}>
            {busy && <Spinner size={14} />} {confirmLabel}
          </button>
        </>
      }
    >
      {message && <div className="text-2">{message}</div>}
      {withReason && (
        <FormField label={reasonLabel} className="mt-2">
          <textarea className="textarea" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      )}
      {requireText && (
        <FormField label={<>Type <code>{requireText}</code> to confirm</>} className="mt-2">
          <input className="input" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </FormField>
      )}
    </Modal>
  );
}
