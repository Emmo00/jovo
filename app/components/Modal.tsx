"use client";

import { useEffect, useRef } from "react";

export function Modal({
  open,
  onClose,
  locked,
  children,
}: {
  open: boolean;
  onClose: () => void;
  locked?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        if (locked) event.preventDefault();
      }}
      aria-modal="true"
    >
      {open && children}
    </dialog>
  );
}
