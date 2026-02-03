import React, { useRef, useEffect, useState } from 'react';
import { NodeData, Port, Position, Size } from '../types';
import { getPortsForNode } from '../constants';
import { X, Play, GripVertical } from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';

interface NodeProps {
  data: NodeData;
  isSelected: boolean;
  scale: number;
  onMove: (id: string, pos: Position) => void;
  onResize: (id: string, size: Size) => void;
  onDelete: (id: string) => void;
  onRun: (id: string) => void;
  onPortClick: (e: React.MouseEvent, portId: string, isInput: boolean) => void;
  logs?: any[]; // Passed only for Terminals
  children?: React.ReactNode;
}

export const Node: React.FC<NodeProps> = ({
  data,
  isSelected,
  scale,
  onMove,
  onResize,
  onDelete,
  onRun,
  onPortClick,
  logs,
  children
}) => {
  const ports = getPortsForNode(data.id, data.type);
  const inputs = ports.filter(p => p.type === 'input');
  const outputs = ports.filter(p => p.type === 'output');
  
  const nodeRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const initialPosRef = useRef<Position>({ x: 0, y: 0 });
  const initialSizeRef = useRef<Size>({ width: 0, height: 0 });

  // Auto-scroll terminal
  useEffect(() => {
    if (data.type === 'TERMINAL' && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.nodrag')) return;
    
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPosRef.current = { ...data.position };
  };

  const handleResizePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialSizeRef.current = { ...data.size };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;

    if (isDragging) {
      const dx = (e.clientX - dragStartRef.current.x) / scale;
      const dy = (e.clientY - dragStartRef.current.y) / scale;
      onMove(data.id, {
        x: initialPosRef.current.x + dx,
        y: initialPosRef.current.y + dy,
      });
    }

    if (isResizing) {
      const dx = (e.clientX - dragStartRef.current.x) / scale;
      const dy = (e.clientY - dragStartRef.current.y) / scale;
      onResize(data.id, {
        width: Math.max(250, initialSizeRef.current.width + dx),
        height: Math.max(100, initialSizeRef.current.height + dy),
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    setIsResizing(false);
    dragStartRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Generate Line Numbers
  const lineCount = data.content.split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div
      ref={nodeRef}
      className={`absolute flex flex-col bg-panel border rounded-lg shadow-2xl transition-shadow animate-in fade-in zoom-in-95 duration-300 ${
        isSelected ? 'border-accent shadow-accent/20' : 'border-panelBorder'
      }`}
      style={{
        transform: `translate(${data.position.x}px, ${data.position.y}px)`,
        width: data.size.width,
        height: data.size.height,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-panelBorder bg-zinc-900/50 rounded-t-lg select-none">
        <div className="flex items-center gap-2 text-zinc-400 font-medium text-sm">
          <GripVertical size={14} className="opacity-50" />
          {data.title}
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={() => onRun(data.id)}
            className="nodrag p-1.5 hover:bg-green-500/20 text-green-500 rounded transition-colors"
            title="Start / Run"
          >
            <Play size={14} fill="currentColor" />
          </button>
          <button 
            onClick={() => onDelete(data.id)}
            className="nodrag p-1.5 hover:bg-red-500/20 text-red-500 rounded transition-colors"
            title="Delete"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden relative group nodrag flex flex-col">
        {/* Render children passed from App if any (like Preview iframe or Terminal list) */}
        {data.type === 'PREVIEW' || data.type === 'TERMINAL' ? (
             data.type === 'TERMINAL' ? (
                 <div className="w-full h-full bg-black p-2 font-mono text-xs overflow-y-auto custom-scrollbar">
                    {(!logs || logs.length === 0) ? (
                        <span className="text-zinc-600 italic">Waiting for logs...</span>
                    ) : (
                        logs.map((log, i) => (
                            <div key={i} className={`mb-1 border-b border-zinc-900 pb-0.5 animate-in fade-in slide-in-from-left-1 ${
                                log.type === 'error' ? 'text-red-400' : 
                                log.type === 'warn' ? 'text-yellow-400' : 
                                'text-zinc-300'
                            }`}>
                                <span className="text-zinc-600 mr-2">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                                {log.message}
                            </div>
                        ))
                    )}
                    <div ref={terminalEndRef} />
                 </div>
             ) : (
                 <iframe
                    id={`preview-iframe-${data.id}`}
                    title="preview"
                    className="w-full h-full bg-white"
                    sandbox="allow-scripts allow-same-origin allow-modals"
                />
             )
        ) : (
             /* Code Editor container - editor injected as child */
            <div className="w-full h-full bg-[#0f0f11] overflow-auto custom-scrollbar flex">
               {/* Line Numbers */}
               <div 
                  className="bg-[#0f0f11] text-zinc-600 text-right pr-3 pl-2 select-none border-r border-zinc-800"
                  style={{ 
                    fontFamily: '"JetBrains Mono", monospace', 
                    fontSize: 13,
                    lineHeight: '1.5', // Must match Editor
                    minHeight: '100%',
                    paddingTop: 12,
                    paddingBottom: 12
                  }}
               >
                 <pre className="m-0 font-inherit">{lineNumbers}</pre>
               </div>
               
               {/* Editor */}
               <div className="flex-1 min-w-0">
                  {React.Children.map(children, child => child)}
               </div>
            </div>
        )}
      </div>

      {/* Inputs (Left) */}
      <div className="absolute top-[52px] -left-3 flex flex-col gap-[28px] pointer-events-none">
        {inputs.map((port) => (
          <div 
            key={port.id} 
            className="relative group flex items-center h-3 pointer-events-auto"
            title={port.label}
          >
            <div 
              className="w-3 h-3 bg-zinc-600 border border-zinc-900 rounded-full hover:bg-accent hover:scale-125 transition-all cursor-pointer nodrag"
              onClick={(e) => onPortClick(e, port.id, true)}
              data-port-id={port.id}
            />
            <span className="absolute left-4 text-[10px] text-zinc-500 uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 px-1 rounded pointer-events-none whitespace-nowrap z-50">
              {port.label}
            </span>
          </div>
        ))}
      </div>

      {/* Outputs (Right) */}
      <div className="absolute top-[52px] -right-3 flex flex-col gap-[28px] pointer-events-none">
        {outputs.map((port) => (
          <div 
            key={port.id} 
            className="relative group flex items-center justify-end h-3 pointer-events-auto"
            title={port.label}
          >
             <span className="absolute right-4 text-[10px] text-zinc-500 uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 px-1 rounded pointer-events-none whitespace-nowrap z-50">
              {port.label}
            </span>
            <div 
              className="w-3 h-3 bg-zinc-600 border border-zinc-900 rounded-full hover:bg-accent hover:scale-125 transition-all cursor-pointer nodrag"
              onClick={(e) => onPortClick(e, port.id, false)}
              data-port-id={port.id}
            />
          </div>
        ))}
      </div>

      {/* Resize Handle */}
      <div 
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-center justify-center opacity-50 hover:opacity-100 nodrag"
        onPointerDown={handleResizePointerDown}
      >
        <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full" />
      </div>
    </div>
  );
};
