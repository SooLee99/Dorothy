'use client';

import {
  Play,
  Square,
  Maximize2,
  Minimize2,
  X,
  RotateCcw,
  GripVertical,
  ShieldOff,
  Bot,
  Shield,
  Gauge,
} from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { CHARACTER_FACES, STATUS_COLORS, PROVIDER_BADGE } from '../constants';

interface TerminalPanelHeaderProps {
  agent: AgentStatus;
  isFullscreen: boolean;
  isBroadcasting: boolean;
  tabType: 'custom' | 'project';
  agentOptions?: AgentStatus[];
  onChangeAgent?: (newAgentId: string) => void;
  onStart: () => void;
  onStop: () => void;
  onFullscreen: () => void;
  onExitFullscreen: () => void;
  onClear: () => void;
  onRemove: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export default function TerminalPanelHeader({
  agent,
  isFullscreen,
  isBroadcasting,
  tabType,
  agentOptions,
  onChangeAgent,
  onStart,
  onStop,
  onFullscreen,
  onExitFullscreen,
  onClear,
  onRemove,
  onContextMenu,
}: TerminalPanelHeaderProps) {
  const emoji = agent.name?.toLowerCase() === 'bitwonka'
    ? '🐸'
    : CHARACTER_FACES[agent.character || 'robot'] || '🤖';
  const name = agent.name || `Agent ${agent.id.slice(0, 6)}`;
  const projectName = agent.projectPath.split('/').pop() || '';
  const status = STATUS_COLORS[agent.status] || STATUS_COLORS.idle;
  const engine = PROVIDER_BADGE[agent.provider || ''] || PROVIDER_BADGE.default;
  const engineTitle = `엔진: ${agent.provider || 'unknown'}${agent.model ? ` · 모델: ${agent.model}` : ''}`;

  const showDragHandle = tabType === 'custom';
  const showRemoveButton = tabType === 'custom';

  return (
    <div
      className={`${showDragHandle ? 'terminal-drag-handle' : ''} window-no-drag flex items-center gap-2 px-3 py-1.5 !rounded-none bg-secondary border-b border-border select-none`}
      onContextMenu={onContextMenu}
    >
      {/* Drag handle grip — custom tabs only */}
      {showDragHandle && (
        <GripVertical className="w-3 h-3 text-muted-foreground/50 flex-shrink-0" />
      )}

      {/* Agent identity — selectable on custom tabs so the user can swap which agent runs here */}
      <span className="text-base">{emoji}</span>
      {onChangeAgent && agentOptions && agentOptions.length > 1 ? (
        <select
          value={agent.id}
          onChange={(e) => onChangeAgent(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          title="이 터미널의 에이전트 변경"
          className="text-xs font-medium text-foreground bg-secondary border border-border rounded px-1 py-0.5 max-w-[140px] cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary/40"
        >
          {agentOptions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || `Agent ${a.id.slice(0, 6)}`}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-xs font-medium text-foreground truncate max-w-[120px]">{name}</span>
      )}

      {/* Engine/provider badge — which agent/engine this terminal runs */}
      <span
        className={`text-[10px] px-1.5 py-0.5 font-medium ${engine.bg} ${engine.text} whitespace-nowrap`}
        title={engineTitle}
      >
        {engine.label}{agent.model ? ` · ${agent.model}` : ''}
      </span>

      {/* Status badge */}
      <span className={`text-[10px] px-1.5 py-0.5 font-medium ${status.bg} ${status.text}`}>
        {agent.status}
      </span>

      {/* Project name */}
      <span className="text-[10px] text-muted-foreground truncate max-w-[100px] hidden lg:inline">
        {projectName}
      </span>

      {/* Broadcast indicator */}
      {isBroadcasting && (
        <span className="text-[10px] px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 font-medium animate-pulse">
          BROADCAST
        </span>
      )}

      {/* Permission mode indicator */}
      {(agent.permissionMode === 'auto' || (!agent.permissionMode && agent.skipPermissions)) && (
        <span title="Auto mode — runs autonomously">
          <Bot className="w-3 h-3 text-amber-400" />
        </span>
      )}
      {agent.permissionMode === 'bypass' && (
        <span title="Bypass mode — all permissions skipped">
          <ShieldOff className="w-3 h-3 text-red-400" />
        </span>
      )}
      {agent.permissionMode === 'normal' && (
        <span title="Normal mode — asks for permissions">
          <Shield className="w-3 h-3 text-blue-400" />
        </span>
      )}

      {/* Effort indicator */}
      {agent.effort === 'high' && (
        <span title="High effort — extended thinking">
          <Gauge className="w-3 h-3 text-purple-400" />
        </span>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session ID (truncated) */}
      <span className="text-[10px] text-muted-foreground font-mono hidden xl:inline">
        {agent.id.slice(0, 8)}
      </span>

      {/* Action buttons */}
      <div className="flex items-center gap-0.5 [&_button]:cursor-pointer" onMouseDown={e => e.stopPropagation()}>
        {agent.status === 'running' || agent.status === 'waiting' ? (
          <button
            onClick={onStop}
            className="p-1 hover:bg-primary/10 transition-colors text-red-400 hover:text-red-300"
            title="Stop agent"
          >
            <Square className="w-3 h-3" />
          </button>
        ) : (
          <button
            onClick={onStart}
            className="p-1 hover:bg-primary/10 transition-colors text-green-400 hover:text-green-300"
            title="Start agent"
          >
            <Play className="w-3 h-3" />
          </button>
        )}

        <button
          onClick={onClear}
          className="p-1 hover:bg-primary/10 transition-colors text-muted-foreground hover:text-foreground"
          title="Clear terminal"
        >
          <RotateCcw className="w-3 h-3" />
        </button>

        <button
          onClick={isFullscreen ? onExitFullscreen : onFullscreen}
          className="p-1 hover:bg-primary/10 transition-colors text-muted-foreground hover:text-foreground"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>

        {/* Remove button — custom tabs only */}
        {showRemoveButton && !isFullscreen && (
          <button
            onClick={onRemove}
            className="p-1 hover:bg-primary/10 transition-colors text-muted-foreground hover:text-red-400"
            title="Remove from tab"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
