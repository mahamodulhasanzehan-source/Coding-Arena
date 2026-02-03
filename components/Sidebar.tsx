import React from 'react';
import { NodeData } from '../types';
import { X, FileCode, Monitor, TerminalSquare } from 'lucide-react';

interface SidebarProps {
  isOpen: boolean;
  nodes: NodeData[];
  onNodeClick: (id: string) => void;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, nodes, onNodeClick, onClose }) => {
  const codeNodes = nodes.filter(n => n.type === 'CODE');
  const previewNodes = nodes.filter(n => n.type === 'PREVIEW');
  const terminalNodes = nodes.filter(n => n.type === 'TERMINAL');

  return (
    <div 
      className={`fixed top-0 right-0 h-full w-72 bg-panel border-l border-panelBorder shadow-2xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
    >
      <div className="h-12 border-b border-panelBorder flex items-center justify-between px-4 bg-zinc-900/50 shrink-0">
        <span className="font-semibold text-zinc-300">Modules</span>
        <button 
            onClick={onClose}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-white transition-colors"
        >
            <X size={18} />
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {/* CODE SECTION (Gold) */}
        <div className="flex-1 flex flex-col border-b border-panelBorder min-h-0">
            <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2 text-amber-500 font-medium text-xs uppercase tracking-wider shrink-0">
                <FileCode size={14} /> Code
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                {codeNodes.map(node => (
                    <button
                        key={node.id}
                        onClick={() => onNodeClick(node.id)}
                        className="w-full text-left px-3 py-2 rounded text-zinc-400 hover:text-amber-400 hover:bg-amber-500/10 text-sm transition-colors truncate"
                    >
                        {node.title}
                    </button>
                ))}
                {codeNodes.length === 0 && <span className="text-zinc-700 text-xs px-3 py-2 italic">No code modules</span>}
            </div>
        </div>

        {/* PREVIEW SECTION (Blue) */}
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

        {/* TERMINAL SECTION (Grey) */}
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
      </div>
    </div>
  );
};