import React from 'react';
import { Code2, Monitor, TerminalSquare, Trash2, Copy, Unplug, Bot } from 'lucide-react';
import { NodeType, Position } from '../types';

interface ContextMenuProps {
  position: Position;
  targetNodeId?: string;
  targetPortId?: string; // New: Supports port actions
  onAdd: (type: NodeType) => void;
  onDeleteNode: (id: string) => void;
  onDuplicateNode: (id: string) => void;
  onDisconnect: (portId: string) => void;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ 
  position, 
  targetNodeId, 
  targetPortId,
  onAdd, 
  onDeleteNode,
  onDuplicateNode,
  onDisconnect,
  onClose 
}) => {
  
  // Port Context Menu
  if (targetPortId) {
    return (
      <div 
        className="fixed z-50 bg-panel border border-panelBorder rounded-lg shadow-2xl overflow-hidden min-w-[160px] animate-in fade-in zoom-in-95 duration-100"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
         <button
          onClick={() => onDisconnect(targetPortId)}
          className="w-full text-left px-4 py-2 text-sm text-yellow-500 hover:bg-zinc-800 transition-colors flex items-center gap-2"
        >
          <Unplug size={14} />
          Disconnect
        </button>
      </div>
    );
  }

  // Node Context Menu
  if (targetNodeId) {
    return (
      <div 
        className="fixed z-50 bg-panel border border-panelBorder rounded-lg shadow-2xl overflow-hidden min-w-[160px] animate-in fade-in zoom-in-95 duration-100"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="px-2 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider bg-zinc-900/50">
          Node Actions
        </div>
        <button
          onClick={() => onDuplicateNode(targetNodeId)}
          className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-2"
        >
          <Copy size={14} />
          Duplicate
        </button>
        <button
          onClick={() => onDeleteNode(targetNodeId)}
          className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors flex items-center gap-2"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    );
  }

  // Canvas Context Menu
  const items = [
    { label: 'Code Canvas', type: 'CODE', icon: <Code2 size={16} /> },
    { label: 'Preview Canvas', type: 'PREVIEW', icon: <Monitor size={16} /> },
    { label: 'Terminal', type: 'TERMINAL', icon: <TerminalSquare size={16} /> },
    { label: 'AI Assistant', type: 'AI_CHAT', icon: <Bot size={16} /> },
  ] as const;

  return (
    <div 
      className="fixed z-50 bg-panel border border-panelBorder rounded-lg shadow-2xl overflow-hidden min-w-[180px] animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2 py-1.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider bg-zinc-900/50">
        Add Node
      </div>
      {items.map((item) => (
        <button
          key={item.type}
          onClick={() => onAdd(item.type)}
          className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-3"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
};