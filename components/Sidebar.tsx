import React from 'react';
import { NodeData } from '../types';
import { X, FileCode, Monitor, TerminalSquare, Check, CheckCircle2, Circle } from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  nodes: NodeData[];
  onNodeClick: (id: string) => void;
  onClose: () => void;
  selectionMode?: {
      isActive: boolean;
      selectedIds: string[];
      onToggle: (id: string) => void;
      onConfirm: () => void;
  }
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, nodes, onNodeClick, onClose, selectionMode }) => {
  const codeNodes = nodes.filter(n => n.type === 'CODE');
  const previewNodes = nodes.filter(n => n.type === 'PREVIEW');
  const terminalNodes = nodes.filter(n => n.type === 'TERMINAL');

  const isSelecting = selectionMode?.isActive;

  const handleNodeClick = (id: string) => {
      if (isSelecting) {
          selectionMode.onToggle(id);
      } else {
          onNodeClick(id);
      }
  };

  return (
    <div 
      className={`fixed top-0 right-0 h-full w-72 bg-panel border-l border-panelBorder shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
    >
      <div className={`h-12 border-b border-panelBorder flex items-center justify-between px-4 shrink-0 ${isSelecting ? 'bg-indigo-500/10' : 'bg-zinc-900/50'}`}>
        <span className={`font-semibold ${isSelecting ? 'text-indigo-400' : 'text-zinc-300'}`}>
            {isSelecting ? 'Select Files for AI' : 'Modules'}
        </span>
        <button 
            onClick={onClose}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-white transition-colors"
        >
            <X size={18} />
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0 relative">
        {/* CODE SECTION (Gold) */}
        <div className="flex-1 flex flex-col border-b border-panelBorder min-h-0">
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-amber-500 font-medium text-xs uppercase tracking-wider shrink-0">
                <FileCode size={14} /> Code
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                {codeNodes.map(node => {
                    const isSelected = isSelecting && selectionMode.selectedIds.includes(node.id);
                    return (
                        <button
                            key={node.id}
                            onClick={() => handleNodeClick(node.id)}
                            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors truncate flex items-center justify-between group ${
                                isSelected 
                                    ? 'bg-amber-500/20 text-amber-300' 
                                    : 'text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10'
                            }`}
                        >
                            <span>{node.title}</span>
                            {isSelecting && (
                                <span className={isSelected ? 'text-amber-500' : 'text-zinc-600 group-hover:text-amber-500/50'}>
                                    {isSelected ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                                </span>
                            )}
                        </button>
                    )
                })}
                {codeNodes.length === 0 && <span className="text-zinc-700 text-xs px-3 py-2 italic">No code modules</span>}
            </div>
        </div>

        {/* PREVIEW SECTION (Blue) - Disabled during selection to focus on code */}
        {!isSelecting && (
            <div className="flex-1 flex flex-col border-b border-panelBorder min-h-0">
                <div className="bg-blue-500/10 border-b border-blue-500/20 px-4 py-2 flex items-center gap-2 text-blue-500 font-medium text-xs uppercase tracking-wider shrink-0">
                    <Monitor size={14} /> Preview
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                    {previewNodes.map(node => (
                        <button
                            key={node.id}
                            onClick={() => onNodeClick(node.id)}
                            className="w-full text-left px-3 py-2 rounded text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 text-sm transition-colors truncate"
                        >
                            {node.title}
                        </button>
                    ))}
                    {previewNodes.length === 0 && <span className="text-zinc-700 text-xs px-3 py-2 italic">No preview modules</span>}
                </div>
            </div>
        )}

        {/* TERMINAL SECTION (Grey) - Disabled during selection */}
        {!isSelecting && (
            <div className="flex-1 flex flex-col min-h-0">
                <div className="bg-zinc-700/10 border-b border-zinc-700/20 px-4 py-2 flex items-center gap-2 text-zinc-400 font-medium text-xs uppercase tracking-wider shrink-0">
                    <TerminalSquare size={14} /> Terminal
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                    {terminalNodes.map(node => (
                        <button
                            key={node.id}
                            onClick={() => onNodeClick(node.id)}
                            className="w-full text-left px-3 py-2 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 text-sm transition-colors truncate"
                        >
                            {node.title}
                        </button>
                    ))}
                    {terminalNodes.length === 0 && <span className="text-zinc-700 text-xs px-3 py-2 italic">No terminal modules</span>}
                </div>
            </div>
        )}

        {/* OK Confirmation Button for Selection Mode */}
        {isSelecting && (
             <div className="p-4 border-t border-panelBorder bg-panel">
                 <button 
                    onClick={selectionMode.onConfirm}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium text-sm flex items-center justify-center gap-2 transition-colors"
                 >
                     <Check size={16} /> OK
                 </button>
                 <p className="text-center text-xs text-zinc-500 mt-2">
                     Select files for the AI to read & edit.
                 </p>
             </div>
        )}
      </div>
    </div>
  );
};