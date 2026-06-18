import type { GridDefinition, LayoutPreset, KeyboardShortcut } from './types';

// Re-export terminal theme/config from AgentWorld for consistency
export { TERMINAL_THEME, TERMINAL_CONFIG, CHARACTER_FACES } from '@/components/AgentWorld/constants';

// Layout preset definitions
export const LAYOUT_PRESETS: Record<LayoutPreset, GridDefinition> = {
  'single': { cols: 1, rows: 1, label: 'Single', icon: '[ ]', maxPanels: 1 },
  '2-col': { cols: 2, rows: 1, label: '2 Column', icon: '[ | ]', maxPanels: 2 },
  '2-row': { cols: 1, rows: 2, label: '2 Row', icon: '[-]', maxPanels: 2 },
  '2x2': { cols: 2, rows: 2, label: '2x2 Grid', icon: '[+]', maxPanels: 4 },
  '3x2': { cols: 3, rows: 2, label: '3x2 Grid', icon: '[|||]', maxPanels: 6 },
  '3x3': { cols: 3, rows: 3, label: '3x3 Grid', icon: '[###]', maxPanels: 9 },
  'focus': { cols: 2, rows: 1, label: 'Focus', icon: '[> |]', maxPanels: 2 },
};

// Auto-calculate best layout based on agent count
export function getAutoLayout(agentCount: number): LayoutPreset {
  if (agentCount <= 1) return 'single';
  if (agentCount === 2) return '2-col';
  if (agentCount <= 4) return '2x2';
  if (agentCount <= 6) return '3x2';
  return '3x3';
}

// Keyboard shortcuts
export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { key: '1', ctrl: true, description: 'Focus terminal 1', action: 'focus:0' },
  { key: '2', ctrl: true, description: 'Focus terminal 2', action: 'focus:1' },
  { key: '3', ctrl: true, description: 'Focus terminal 3', action: 'focus:2' },
  { key: '4', ctrl: true, description: 'Focus terminal 4', action: 'focus:3' },
  { key: '5', ctrl: true, description: 'Focus terminal 5', action: 'focus:4' },
  { key: '6', ctrl: true, description: 'Focus terminal 6', action: 'focus:5' },
  { key: '7', ctrl: true, description: 'Focus terminal 7', action: 'focus:6' },
  { key: '8', ctrl: true, description: 'Focus terminal 8', action: 'focus:7' },
  { key: '9', ctrl: true, description: 'Focus terminal 9', action: 'focus:8' },
  { key: 'n', ctrl: true, shift: true, description: 'New agent', action: 'new-agent' },
  { key: 'f', ctrl: true, shift: true, description: 'Toggle fullscreen', action: 'toggle-fullscreen' },
  { key: 'b', ctrl: true, shift: true, description: 'Toggle broadcast', action: 'toggle-broadcast' },
  { key: 's', ctrl: true, shift: true, description: 'Toggle sidebar', action: 'toggle-sidebar' },
  { key: 'Escape', description: 'Exit fullscreen', action: 'exit-fullscreen' },
];

// Engine/provider badge styling — shows which agent/engine drives each terminal.
// Keyed by AgentStatus.provider; falls back to `default` for unknown/missing.
// 라벨은 사용자가 한눈에 GPT 인지 Claude 인지 알 수 있게 명시(공급사 포함).
export const PROVIDER_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  claude: { label: 'Claude (Anthropic)', bg: 'bg-orange-500/20', text: 'text-orange-700' },
  codex: { label: 'GPT (Codex)', bg: 'bg-green-600/20', text: 'text-green-700' },
  gemini: { label: 'Gemini (Google)', bg: 'bg-blue-500/20', text: 'text-blue-700' },
  pi: { label: 'Pi (Inflection)', bg: 'bg-purple-500/20', text: 'text-purple-700' },
  local: { label: 'Local', bg: 'bg-gray-500/20', text: 'text-gray-700' },
  default: { label: 'Engine ?', bg: 'bg-gray-500/15', text: 'text-gray-600' },
};

// Status colors (light theme compatible)
export const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-green-600/15', text: 'text-green-700', dot: 'bg-green-600' },
  waiting: { bg: 'bg-amber-500/15', text: 'text-amber-700', dot: 'bg-amber-500' },
  idle: { bg: 'bg-gray-500/15', text: 'text-gray-600', dot: 'bg-gray-400' },
  error: { bg: 'bg-red-500/15', text: 'text-red-700', dot: 'bg-red-500' },
  completed: { bg: 'bg-primary/15', text: 'text-primary', dot: 'bg-primary' },
};

// Local storage key for persisting sidebar state
export const SIDEBAR_STORAGE_KEY = 'terminals-view-sidebar';
