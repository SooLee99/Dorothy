'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  FolderKanban,
  Sparkles,
  Puzzle,
  Settings,
  ChevronLeft,
  ChevronRight,
  Bot,
  BarChart2,
  CalendarClock,
  Zap,
  Columns,
  Moon,
  Sun,
  Archive,
  Brain,
  Gift,
  Heart,
  Workflow,
  ShieldCheck,
  Network,
  Building2,
  Users,
  PlayCircle,
  TerminalSquare,
  GitPullRequest,
  FileText,
  Lightbulb,
  Stethoscope,
  Layers,
  Factory,
  Plug,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

// Custom icon component for Pallet Town using the pokemon logo
const PalletTownIcon = ({ className }: { className?: string }) => (
  <img src="/pokemon/p.png" alt="" className={className} style={{ imageRendering: 'pixelated', objectFit: 'contain' }} />
);
import { useStore } from '@/store';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Phase 6-AL — 기능/경로 삭제 없이 그룹·순서·라벨만 정리(기본/운영/고급).
type NavIcon = React.ComponentType<{ className?: string }>;
type NavEntry =
  | { section: string }
  | { href: string; icon: NavIcon; label: string; shortcut?: string };

const navItems: NavEntry[] = [
  { section: '자동개발' },
  { href: '/', icon: LayoutDashboard, label: '대시보드', shortcut: '1' },
  { href: '/projects', icon: FolderKanban, label: '프로젝트', shortcut: '5' },
  { href: '/kanban', icon: Columns, label: '칸반', shortcut: '3' },
  { href: '/sessions', icon: TerminalSquare, label: '에이전트 터미널' },
  { href: '/app-factory', icon: Factory, label: '앱 팩토리' },

  { section: '운영' },
  { href: '/agents', icon: Bot, label: '에이전트', shortcut: '2' },
  { href: '/reports', icon: FileText, label: '리포트' },
  { href: '/pr', icon: GitPullRequest, label: '풀 리퀘스트' },
  { href: '/approvals', icon: ShieldCheck, label: '승인 대기' },
  { href: '/auto-company', icon: Workflow, label: '오토컴퍼니' },
  { href: '/automations', icon: Zap, label: '자동화', shortcut: '9' },
  { href: '/recurring-tasks', icon: CalendarClock, label: '스케줄', shortcut: '8' },
  { href: '/agent-activity', icon: Users, label: '에이전트 작업' },
  { href: '/agent-workflows', icon: Workflow, label: '에이전트 워크플로우' },
  { href: '/companies', icon: Building2, label: '회사' },
  { href: '/templates', icon: Sparkles, label: '템플릿', shortcut: 'T' },
  { href: '/integrations/github', icon: Plug, label: '연동 설정' },

  { section: '고급 / 진단' },
  { href: '/runs', icon: PlayCircle, label: '실행 기록' },
  { href: '/diagnostics', icon: Stethoscope, label: '진단' },
  { href: '/improvements', icon: Lightbulb, label: '개선' },
  { href: '/skill-candidates', icon: Layers, label: '스킬 후보' },
  { href: '/harness', icon: Network, label: '하네스' },
  { href: '/vault', icon: Archive, label: '볼트', shortcut: '4' },
  { href: '/memory', icon: Brain, label: '메모리', shortcut: 'M' },
  { href: '/skills', icon: Sparkles, label: '스킬', shortcut: '6' },
  { href: '/plugins', icon: Puzzle, label: '플러그인', shortcut: '7' },
  { href: '/usage', icon: BarChart2, label: '사용량', shortcut: '0' },
  { href: '/pallet-town', icon: PalletTownIcon, label: '클로드몬' },
];

interface SidebarProps {
  isMobile?: boolean;
}

function useWhatsNewBadge() {
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const check = () => {
      const lastSeen = Number(localStorage.getItem(WHATS_NEW_STORAGE_KEY) || '0');
      setHasNew(LATEST_RELEASE.id > lastSeen);
    };
    check();
    window.addEventListener('whats-new-seen', check);
    return () => window.removeEventListener('whats-new-seen', check);
  }, []);

  return hasNew;
}

export default function Sidebar({ isMobile = false }: SidebarProps) {
  const pathname = usePathname();
  const { sidebarCollapsed, toggleSidebar, mobileMenuOpen, setMobileMenuOpen, darkMode, toggleDarkMode, vaultUnreadCount } = useStore();
  const whatsNewHasNew = useWhatsNewBadge();

  // For mobile, sidebar is always expanded (240px) when open
  const sidebarWidth = isMobile ? 240 : (sidebarCollapsed ? 72 : 240);
  const showLabels = isMobile || !sidebarCollapsed;

  // Close mobile menu when navigating
  const handleNavClick = () => {
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  // Desktop sidebar
  if (!isMobile) {
    return (
      <motion.aside
        initial={false}
        animate={{ width: sidebarWidth }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="fixed left-0 top-0 h-screen bg-card border-r border-border flex-col z-50 hidden lg:flex"
      >
        {/* Logo — top area also serves as drag region for macOS traffic lights */}
        <div className="window-drag flex items-center px-4 pt-5 pb-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
              <img src="/dorothy-without-text.png" alt="Dorothy" className="w-full h-full object-cover scale-150" />
            </div>
            {showLabels && (
              <div>
                <img src="/text.png" alt="Dorothy" className="h-6 w-auto object-contain" />
              </div>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item, idx) => {
            if ('section' in item) {
              return showLabels ? (
                <div key={`sec-${item.section}`} className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {item.section}
                </div>
              ) : (
                <div key={`sec-${idx}`} className="my-2 border-t border-border/60" />
              );
            }
            const isActive = item.href === '/'
              ? pathname === '/'
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`
                  group flex items-center gap-3 px-3 py-2.5 transition-all duration-150 cursor-pointer
                  ${isActive
                    ? 'bg-primary/20 text-primary font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                  }
                `}
              >
                <div className="relative">
                  <item.icon className="w-5 h-5" />
                  {item.href === '/vault' && vaultUnreadCount > 0 && !showLabels && (
                    <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center text-[8px] font-bold bg-primary text-primary-foreground rounded-full px-0.5">
                      {vaultUnreadCount}
                    </span>
                  )}
                </div>
                {showLabels && (
                  <span className="text-sm flex-1">
                    {item.label}
                  </span>
                )}
                {item.href === '/vault' && vaultUnreadCount > 0 && showLabels && (
                  <span className="min-w-[20px] h-[20px] flex items-center justify-center text-[10px] font-medium bg-primary text-primary-foreground rounded-full px-1">
                    {vaultUnreadCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* What's New + Status indicator */}
        <div className="border-t border-border">
          {showLabels && (
            <>
              <Link
                href="/whats-new"
                className={`flex items-center gap-3 px-5 py-3 transition-colors cursor-pointer ${
                  pathname === '/whats-new'
                    ? 'bg-primary/20 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
              >
                <div className="relative">
                  <Gift className="w-5 h-5" />
                  {whatsNewHasNew && (
                    <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                  )}
                </div>
                <span className="text-sm flex-1">새 소식</span>
                {whatsNewHasNew && (
                  <span className="min-w-[20px] h-[20px] flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full px-1">
                    1
                  </span>
                )}
              </Link>
              <div className="flex items-center gap-3 px-5 py-3 border-t border-border text-muted-foreground text-sm">
                <span className="relative flex w-5 h-5 items-center justify-center">
                  <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-green-500 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span>연결됨</span>
              </div>
            </>
          )}
          {!showLabels && (
            <Link
              href="/whats-new"
              className={`flex items-center justify-center py-3 transition-colors ${
                pathname === '/whats-new'
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              <div className="relative">
                <Gift className="w-5 h-5" />
                {whatsNewHasNew && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                )}
              </div>
            </Link>
          )}
        </div>

        {/* Settings & Collapse */}
        <div className="border-t border-border">
          <Link
            href="/settings"
            className={`
              flex items-center gap-3 px-5 py-3 transition-colors cursor-pointer
              ${pathname === '/settings' || pathname.startsWith('/settings/')
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }
            `}
          >
            <Settings className="w-5 h-5" />
            {showLabels && <span className="text-sm">설정</span>}
          </Link>
          <Link
            href="/support"
            aria-label="지원"
            title="지원"
            className={`
              flex items-center gap-3 px-5 py-3 transition-colors
              ${pathname === '/support'
                ? 'bg-primary/20 text-primary border-l-2 border-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }
            `}
          >
            <Heart className="w-5 h-5 text-red-500" fill="currentColor" />
            {showLabels && <span className="text-sm">지원</span>}
          </Link>
          <button
            onClick={toggleDarkMode}
            className="w-full flex items-center gap-3 px-5 py-3 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
          >
            {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            {showLabels && <span className="text-sm">{darkMode ? 'Light Mode' : 'Dark Mode'}</span>}
          </button>
          <button
            onClick={toggleSidebar}
            className="w-full flex items-center gap-3 px-5 py-3 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-5 h-5" />
            ) : (
              <>
                <ChevronLeft className="w-5 h-5" />
                <span className="text-sm">접기</span>
              </>
            )}
          </button>
        </div>
      </motion.aside>
    );
  }

  // Mobile sidebar (drawer)
  return (
    <AnimatePresence>
      {mobileMenuOpen && (
        <motion.aside
          initial={{ x: -sidebarWidth }}
          animate={{ x: 0 }}
          exit={{ x: -sidebarWidth }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="fixed left-0 top-0 h-screen bg-card border-r border-border flex flex-col z-50 lg:hidden"
          style={{ width: sidebarWidth }}
        >
          {/* Logo */}
          <div className="h-14 flex items-center px-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                <img src="/dorothy-without-text.png" alt="Dorothy" className="w-full h-full object-cover scale-150" />
              </div>
              <img src="/text.png" alt="Dorothy" className="h-6 w-auto object-contain" />
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
            {navItems.map((item, idx) => {
              if ('section' in item) {
                return (
                  <div key={`msec-${idx}`} className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {item.section}
                  </div>
                );
              }
              const isActive = item.href === '/'
                ? pathname === '/'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleNavClick}
                  className={`
                    group flex items-center gap-3 px-3 py-2.5 transition-all duration-150
                    ${isActive
                      ? 'bg-primary/20 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                    }
                  `}
                >
                  <div className="relative">
                    <item.icon className="w-5 h-5" />
                  </div>
                  <span className="text-sm flex-1">
                    {item.label}
                  </span>
                  {item.href === '/vault' && vaultUnreadCount > 0 && (
                    <span className="min-w-[20px] h-[20px] flex items-center justify-center text-[10px] font-medium bg-primary text-primary-foreground rounded-full px-1">
                      {vaultUnreadCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* What's New + Status indicator */}
          <div className="border-t border-border">
            <Link
              href="/whats-new"
              onClick={handleNavClick}
              className={`flex items-center gap-3 px-5 py-3 transition-colors cursor-pointer ${
                pathname === '/whats-new'
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
            >
              <div className="relative">
                <Gift className="w-5 h-5" />
                {whatsNewHasNew && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                )}
              </div>
              <span className="text-sm flex-1">What&apos;s New</span>
              {whatsNewHasNew && (
                <span className="min-w-[20px] h-[20px] flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full px-1">
                  1
                </span>
              )}
            </Link>
            <div className="px-4 py-3 border-t border-border">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span>연결됨</span>
              </div>
            </div>
          </div>

          {/* Settings & Theme Toggle */}
          <div className="border-t border-border">
            <Link
              href="/settings"
              onClick={handleNavClick}
              className={`
                flex items-center gap-3 px-5 py-3 transition-colors cursor-pointer
                ${pathname === '/settings' || pathname.startsWith('/settings/')
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }
              `}
            >
              <Settings className="w-5 h-5" />
              <span className="text-sm">설정</span>
            </Link>
            <Link
              href="/support"
              onClick={handleNavClick}
              className={`
                flex items-center gap-3 px-5 py-3 transition-colors
                ${pathname === '/support'
                  ? 'bg-primary/20 text-primary border-l-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }
              `}
            >
              <Heart className="w-5 h-5 text-red-500" fill="currentColor" />
              <span className="text-sm">지원</span>
            </Link>
            <button
              onClick={toggleDarkMode}
              className="w-full flex items-center gap-3 px-5 py-3 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              <span className="text-sm">{darkMode ? 'Light Mode' : 'Dark Mode'}</span>
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
