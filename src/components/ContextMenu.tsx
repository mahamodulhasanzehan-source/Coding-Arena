
import React from 'react';
import { Code2, Monitor, TerminalSquare, Trash2, Copy, Unplug, Package, Image as ImageIcon, Eraser, AlignHorizontalJustifyCenter, AlignVerticalJustifyCenter, StretchHorizontal, StretchVertical, Minimize2, StickyNote, Lock, Unlock, Folder } from 'lucide-react';
import { NodeType, Position } from '../types';

interface ContextMenuProps {
  position: Position;
  targetNodeId?: string;
  targetNode?: any; // To check if it's an image node
  targetPortId?: string; 
  selectedNodeIds?: string[];
  currentUser?: { uid: string; displayName: string } | null;
  onAdd: (type: NodeType) => void;
  onDeleteNode: (id: string) => void;
  onDuplicateNode: (id: string) => void;
  onDisconnect: (portId: string) => void;
  onClearImage?: (id: string) => void;
  onAlign?: (type: 'horizontal' | 'vertical') => void;
  onDistribute?: (type: 'horizontal' | 'vertical') => void;
  onCompact?: (type: 'horizontal' | 'vertical') => void;
  onToggleLock?: (id: string) => void;
  canAlignHorizontal?: boolean;
  canAlignVertical?: boolean;
  canDistributeHorizontal?: boolean;
  canDistributeVertical?: boolean;
  canCompactHorizontal?: boolean;
  canCompactVertical?: boolean;
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ 
  position, 
  targetNodeId,
  targetNode, 
  targetPortId,
  selectedNodeIds = [],
  currentUser,
  onAdd, 
  onDeleteNode,
  onDuplicateNode,
  onDisconnect,
  onClearImage,
  onAlign,
  onDistribute,
  onCompact,
  onToggleLock,
  canAlignHorizontal = false,
  canAlignVertical = false,
  canDistributeHorizontal = false,
  canDistributeVertical = false,
  canCompactHorizontal = false,
  canCompactVertical = false,
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
          className="w-full text-left px-4 py-2 text-sm font-medium text-yellow-500 hover:bg-zinc-800 transition-colors flex items-center gap-2"
        >
          <Unplug size={14} />
          Disconnect
        </button>
      </div>
    );
  }

  // Node Context Menu
  if (targetNodeId) {
    const isMultiSelect = selectedNodeIds.length > 1 && selectedNodeIds.includes(targetNodeId);
    
    // Lock Status Logic
    const isLocked = !!targetNode?.lockedBy;
    const isLockedByMe = currentUser && targetNode?.lockedBy?.uid === currentUser.uid;
    
    // Can Lock: Signed in AND Not Locked
    const showLock = currentUser && !isLocked;
    // Can Unlock: Signed in AND Locked by Me
    const showUnlock = currentUser && isLockedByMe;

    return (
      <div 
        className="fixed z-50 bg-panel border border-panelBorder rounded-lg shadow-2xl overflow-hidden min-w-[200px] animate-in fade-in zoom-in-95 duration-100"
        style={{ left: position.x, top: position.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="px-2 py-1.5 text-xs font-bold text-zinc-500 uppercase tracking-wider bg-zinc-900/50">
          Node Actions
        </div>
        
        {/* Lock/Unlock Actions */}
        {(showLock || showUnlock) && onToggleLock && (
            <div className="border-b border-panelBorder pb-1 mb-1">
                {showLock && (
                    <button
                        onClick={() => onToggleLock(targetNodeId)}
                        className="w-full text-left px-4 py-2 text-sm font-medium text-amber-500 hover:bg-zinc-800 transition-colors flex items-center gap-2"
                    >
                        <Lock size={14} />
                        Lock {isMultiSelect ? 'Selected' : ''}
                    </button>
                )}
                {showUnlock && (
                    <button
                        onClick={() => onToggleLock(targetNodeId)}
                        className="w-full text-left px-4 py-2 text-sm font-medium text-emerald-500 hover:bg-zinc-800 transition-colors flex items-center gap-2"
                    >
                        <Unlock size={14} />
                        Unlock {isMultiSelect ? 'Selected' : ''}
                    </button>
                )}
            </div>
        )}

        {isMultiSelect && onAlign && onDistribute && onCompact && (
            <>
                <button
                    onClick={() => onAlign('horizontal')}
                    disabled={!canAlignHorizontal}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors ${
                        canAlignHorizontal ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <AlignVerticalJustifyCenter size={14} className={canAlignHorizontal ? "" : "opacity-50"} />
                    Align Horizontally
                </button>
                <button
                    onClick={() => onAlign('vertical')}
                    disabled={!canAlignVertical}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors border-b border-panelBorder ${
                        canAlignVertical ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <AlignHorizontalJustifyCenter size={14} className={canAlignVertical ? "" : "opacity-50"} />
                    Align Vertically
                </button>
                
                <button
                    onClick={() => onDistribute('horizontal')}
                    disabled={!canDistributeHorizontal}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors ${
                        canDistributeHorizontal ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <StretchHorizontal size={14} className={canDistributeHorizontal ? "" : "opacity-50"} />
                    Equal Spacing (H)
                </button>
                <button
                    onClick={() => onDistribute('vertical')}
                    disabled={!canDistributeVertical}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors border-b border-panelBorder ${
                        canDistributeVertical ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <StretchVertical size={14} className={canDistributeVertical ? "" : "opacity-50"} />
                    Equal Spacing (V)
                </button>

                <button
                    onClick={() => onCompact('horizontal')}
                    disabled={!canCompactHorizontal}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors ${
                        canCompactHorizontal ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <Minimize2 size={14} className={canCompactHorizontal ? "rotate-90" : "opacity-50 rotate-90"} />
                    Compact Horizontally
                </button>
                <button
                    onClick={() => onCompact('vertical')}
                    disabled={!canCompactVertical}
                    className={`w-full text-left px-4 py-2 text-sm font-medium flex items-center gap-2 transition-colors border-b border-panelBorder ${
                        canCompactVertical ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white' : 'text-zinc-600 cursor-not-allowed'
                    }`}
                >
                    <Minimize2 size={14} className={canCompactVertical ? "" : "opacity-50"} />
                    Compact Vertically
                </button>
            </>
        )}

        {targetNode?.type === 'IMAGE' && onClearImage && (
             <button
                onClick={() => onClearImage(targetNodeId)}
                className="w-full text-left px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-2"
            >
                <Eraser size={14} />
                Clear Image
            </button>
        )}

        <button
          onClick={() => onDuplicateNode(targetNodeId)}
          className="w-full text-left px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-2"
        >
          <Copy size={14} />
          Duplicate
        </button>
        <button
          onClick={() => onDeleteNode(targetNodeId)}
          className="w-full text-left px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-900/20 hover:text-red-300 transition-colors flex items-center gap-2"
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
    { label: 'Folder Group', type: 'FOLDER', icon: <Folder size={16} /> },
    { label: 'Text Module', type: 'TEXT', icon: <StickyNote size={16} /> },
    { label: 'Image Module', type: 'IMAGE', icon: <ImageIcon size={16} /> },
    { label: 'Preview Canvas', type: 'PREVIEW', icon: <Monitor size={16} /> },
    { label: 'Terminal', type: 'TERMINAL', icon: <TerminalSquare size={16} /> },
    { label: 'NPM Package', type: 'NPM', icon: <Package size={16} /> },
  ] as const;

  return (
    <div 
      className="fixed z-50 bg-panel border border-panelBorder rounded-lg shadow-2xl overflow-hidden min-w-[180px] animate-in fade-in zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2 py-1.5 text-xs font-bold text-zinc-500 uppercase tracking-wider bg-zinc-900/50">
        Add Node
      </div>
      {items.map((item) => (
        <button
          key={item.type}
          onClick={() => onAdd(item.type)}
          className="w-full text-left px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors flex items-center gap-3"
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
};
