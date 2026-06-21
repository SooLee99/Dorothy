'use client';

/**
 * 정보 과다 화면 팝업화 — 재사용 generic 상세 모달.
 *
 * 메인은 핵심 요약만 두고, 상세는 항목 클릭 시 이 모달로 옮긴다(정보 손실 0·additive 오버레이).
 * ③의 KanbanCardDetail 은 칸반 전용이라, 어느 화면이든 쓰는 범용 버전을 둔다.
 * Esc/백드롭 클릭으로 닫힘. 열렸을 때 body 스크롤 잠금.
 */
import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

export default function DetailModal({
  open,
  title,
  subtitle,
  onClose,
  children,
  widthClass = 'max-w-2xl',
}: {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[80]"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 16 }}
            transition={{ duration: 0.18 }}
            className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[81] w-full ${widthClass} px-4`}
          >
            <div className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
              <div className="flex items-start justify-between gap-3 px-5 py-3.5 border-b border-border shrink-0">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground truncate">{title}</div>
                  {subtitle && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{subtitle}</div>}
                </div>
                <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-secondary transition-colors shrink-0" aria-label="닫기">
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <div className="p-5 overflow-y-auto">{children}</div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
