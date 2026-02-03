import React, { useRef, useEffect, useState } from 'react';
import { NodeData, Port, Position, Size } from '../types';
import { getPortsForNode } from '../constants';
import { Play, GripVertical, Pencil, Pause, RotateCcw, Plus, Send, Bot, User, FileCode, Loader2 } from 'lucide-react';

interface NodeProps {
  data: NodeData;
  isSelected: boolean;
  isHighlighted?: boolean;
  isRunning?: boolean;
  scale: number;
  isConnected: (portId: string) => boolean;
  onMove: (id: string, pos: Position) => void;
  onResize: (id: string, size: Size) => void;
  onDelete: (id: string) => void;
  onToggleRun: (id: string) => void;
  onRefresh?: (id: string) => void;
  onPortDown: (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => void;
  onPortContextMenu: (e: React.MouseEvent, portId: string) => void;
  onUpdateTitle: (id: string, title: string) => void;
  onSendMessage?: (id: string, text: string) => void; // For AI Chat
  onStartContextSelection?: (id: string) => void; // For AI Chat
  logs?: any[]; 
  children?: React.ReactNode;
}

export const Node: React.FC<NodeProps> = ({
  data,
  isSelected,
  isHighlighted,
  isRunning = false,
  scale,
  isConnected,
  onMove,
  onResize,
  onDelete,
  onToggleRun,
  onRefresh,
  onPortDown,
  onPortContextMenu,
  onUpdateTitle,
  onSendMessage,
  onStartContextSelection,
  logs,
  children
}) => {
  const ports = getPortsForNode(data.id, data.type);
  const inputs = ports.filter(p => p.type === 'input');
  const outputs = ports.filter(p => p.type === 'output');
  
  const nodeRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState(data.title);
  const [chatInput, setChatInput] = useState('');

  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const initialPosRef = useRef<Position>({ x: 0, y: 0 });
  const initialSizeRef = useRef<Size>({ width: 0, height: 0 });

  useEffect(() => {
    if (data.type === 'TERMINAL' && terminalContainerRef.current) {
        const el = terminalContainerRef.current;
        el.scrollTop = el.scrollHeight;
    }
  }, [logs, data.type]);

  // Auto-scroll chat to bottom
  useEffect(() => {
      if (data.type === 'AI_CHAT' && chatContainerRef.current) {
          const el = chatContainerRef.current;
          el.scrollTop = el.scrollHeight;
      }
  }, [data.messages, data.type, data.isLoading]);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Check if the target is part of a nodrag element (inputs, buttons, editors)
    if ((e.target as HTMLElement).closest('.nodrag')) {
        return;
    }
    
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

  const finishEditing = () => {
    setIsEditingTitle(false);
    if (tempTitle.trim()) {
      onUpdateTitle(data.id, tempTitle.trim());
    } else {
      setTempTitle(data.title);
    }
  };

  const handleRunClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleRun(data.id);
  };

  const handleRefreshClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onRefresh) onRefresh(data.id);
  };

  const handleSendChat = () => {
      if (chatInput.trim() && onSendMessage && !data.isLoading) {
          onSendMessage(data.id, chatInput.trim());
          setChatInput('');
      }
  };

  const lineCount = data.content.split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');
  const isCode = data.type === 'CODE';
  const isAutoHeight = isCode && (data.autoHeight !== false);

  // Highlight Styles
  const highlightStyle = isHighlighted
    ? 'border-yellow-500 shadow-[0_0_30px_rgba(234,179,8,0.6)]'
    : (isSelected ? 'border-accent shadow-accent/20' : 'border-panelBorder');

  return (
    <div
      ref={nodeRef}
      className={`absolute flex flex-col bg-panel border rounded-lg shadow-2xl animate-in fade-in zoom-in-95 pointer-events-auto ${highlightStyle}`}
      style={{
        transform: `translate(${data.position.x}px, ${data.position.y}px)`,
        width: data.size.width,
        height: isAutoHeight ? 'auto' : data.size.height,
        minHeight: isCode ? 150 : data.size.height,
        transitionProperty: 'box-shadow, border-color', 
        transitionDuration: isHighlighted ? '0s' : '1s',
        transitionTimingFunction: 'ease-out'
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-panelBorder bg-zinc-900/50 rounded-t-lg select-none shrink-0">
        <div className="flex items-center gap-2 text-zinc-400 font-medium text-sm flex-1">
          <GripVertical size={14} className="opacity-50" />
          {isEditingTitle ? (
            <input 
              type="text" 
              value={tempTitle}
              onChange={(e) => setTempTitle(e.target.value)}
              onBlur={finishEditing}
              onKeyDown={(e) => e.key === 'Enter' && finishEditing()}
              onPointerDown={(e) => e.stopPropagation()} 
              className="bg-black border border-zinc-700 rounded px-1 py-0.5 text-xs w-full nodrag text-white focus:outline-none focus:border-accent select-text"
              autoFocus
            />
          ) : (
             <div className="flex items-center gap-2 group/title">
                {data.type === 'AI_CHAT' && <Bot size={14} className="text-indigo-400" />}
                <span>{data.title}</span>
                <button 
                    onClick={(e) => { e.stopPropagation(); setIsEditingTitle(true); }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="opacity-0 group-hover/title:opacity-100 p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-all nodrag"
                >
                    <Pencil size={12} />
                </button>
             </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Only show Run/Stop button for PREVIEW nodes */}
          {data.type === 'PREVIEW' && (
             <div className="flex items-center gap-1">
               <button 
                  onClick={handleRefreshClick}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 text-zinc-400 hover:text-white hover:bg-zinc-800"
                  title="Refresh"
                >
                   <RotateCcw size={14} />
               </button>
               <button 
                  onClick={handleRunClick}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 ${
                      isRunning ? 'text-yellow-500 hover:bg-yellow-500/20' : 'text-green-500 hover:bg-green-500/20'
                  }`}
                  title={isRunning ? "Stop" : "Run"}
              >
                  {isRunning ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className={`flex-1 relative group nodrag flex flex-col min-h-0 ${isAutoHeight ? 'overflow-visible' : 'overflow-hidden'}`}>
        {data.type === 'PREVIEW' || data.type === 'TERMINAL' ? (
             data.type === 'TERMINAL' ? (
                 <div 
                    ref={terminalContainerRef}
                    className="w-full h-full bg-black p-2 font-mono text-xs overflow-y-auto custom-scrollbar select-text nodrag"
                    onPointerDown={(e) => e.stopPropagation()} 
                 >
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
                 </div>
             ) : (
                 <iframe
                    id={`preview-iframe-${data.id}`}
                    title="preview"
                    className="w-full h-full bg-white nodrag"
                    sandbox="allow-scripts allow-same-origin allow-modals"
                    onPointerDown={(e) => e.stopPropagation()}
                />
             )
        ) : data.type === 'AI_CHAT' ? (
             <div className="flex flex-col h-full bg-zinc-950">
                 {/* Chat History */}
                 <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
                     {(!data.messages || data.messages.length === 0) && (
                         <div className="text-center text-zinc-600 text-xs mt-10">
                             <Bot size={24} className="mx-auto mb-2 opacity-50" />
                             <p>Ask me anything about your code.</p>
                         </div>
                     )}
                     {data.messages?.map((msg, i) => (
                         <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                             <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-1 ${
                                 msg.role === 'user' ? 'bg-zinc-700' : 'bg-indigo-600'
                             }`}>
                                 {msg.role === 'user' ? <User size={14} /> : <Bot size={14} />}
                             </div>
                             <div className={`p-2 rounded-lg text-xs whitespace-pre-wrap max-w-[85%] ${
                                 msg.role === 'user' 
                                    ? 'bg-zinc-800 text-zinc-200' 
                                    : 'bg-indigo-900/30 text-indigo-100 border border-indigo-500/20'
                             }`}>
                                 {msg.text}
                             </div>
                         </div>
                     ))}
                     {data.isLoading && (
                         <div className="flex gap-2 flex-row animate-in fade-in slide-in-from-bottom-2 duration-300">
                             <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-1 bg-indigo-600">
                                 <Bot size={14} />
                             </div>
                             <div className="p-2 rounded-lg bg-indigo-900/30 text-indigo-100 border border-indigo-500/20 w-12 flex items-center justify-center">
                                 <div className="flex space-x-1">
                                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
                                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                                    <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                                 </div>
                             </div>
                         </div>
                     )}
                 </div>
                 
                 {/* Input Area */}
                 <div className="p-2 border-t border-zinc-800 bg-zinc-900/50">
                     {/* Context Chips */}
                     {(data.contextNodeIds?.length || 0) > 0 && (
                         <div className="flex flex-wrap gap-1 mb-2 px-1">
                             {data.contextNodeIds!.map(nodeId => (
                                 <div key={nodeId} className="flex items-center gap-1 bg-amber-500/10 text-amber-500 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/20">
                                     <FileCode size={10} />
                                     <span>File Selected</span> 
                                 </div>
                             ))}
                         </div>
                     )}

                     <div className="relative flex items-center gap-2">
                        <button 
                            onClick={(e) => { e.stopPropagation(); onStartContextSelection?.(data.id); }}
                            className="p-1.5 rounded bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors shrink-0"
                            title="Select files for context"
                            onPointerDown={(e) => e.stopPropagation()}
                            disabled={data.isLoading}
                        >
                            <Plus size={14} />
                        </button>
                        <input
                            type="text"
                            value={chatInput}
                            onChange={(e) => setChatInput(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendChat()}
                            placeholder={data.isLoading ? "Thinking..." : "Ask Gemini..."}
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors nodrag select-text disabled:opacity-50"
                            onPointerDown={(e) => e.stopPropagation()}
                            disabled={data.isLoading}
                        />
                        <button 
                            onClick={(e) => { e.stopPropagation(); handleSendChat(); }}
                            className={`p-1.5 rounded text-white transition-colors shrink-0 flex items-center justify-center ${
                                data.isLoading ? 'bg-indigo-600/50 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500'
                            }`}
                            onPointerDown={(e) => e.stopPropagation()}
                            disabled={data.isLoading}
                        >
                            {data.isLoading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                        </button>
                     </div>
                 </div>
             </div>
        ) : (
            <div 
                className={`w-full bg-[#0f0f11] flex rounded-b-lg nodrag ${isAutoHeight ? '' : 'h-full overflow-auto custom-scrollbar'}`}
                onPointerDown={(e) => e.stopPropagation()}
            >
               <div 
                  className="bg-[#0f0f11] text-zinc-600 text-right pr-3 pl-2 select-none border-r border-zinc-800 shrink-0 sticky left-0 z-10 min-h-full h-full"
                  style={{ 
                    fontFamily: '"JetBrains Mono", monospace', 
                    fontSize: 13,
                    lineHeight: '1.5',
                    paddingTop: 12,
                    paddingBottom: 12,
                  }}
               >
                 <pre className="m-0 font-inherit">{lineNumbers}</pre>
               </div>
               <div className="flex-1 min-w-0 bg-[#0f0f11] cursor-text">
                  {React.Children.map(children, child => child)}
               </div>
            </div>
        )}
      </div>

      {/* Inputs (Left) */}
      <div className="absolute top-[52px] -left-3 flex flex-col gap-[28px] pointer-events-none">
        {inputs.map((port) => {
            const connected = isConnected(port.id);
            return (
              <div 
                key={port.id} 
                className="relative group flex items-center h-3 pointer-events-auto"
                title={port.label}
              >
                <div 
                  className={`w-3 h-3 border border-zinc-900 rounded-full transition-all cursor-crosshair nodrag ${
                    connected ? 'bg-yellow-500' : 'bg-zinc-600 hover:bg-zinc-400'
                  }`}
                  onPointerDown={(e) => onPortDown(e, port.id, data.id, true)}
                  onContextMenu={(e) => onPortContextMenu(e, port.id)}
                  data-port-id={port.id}
                  data-node-id={data.id}
                />
                <span className="absolute left-4 text-[10px] text-zinc-500 uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 px-1 rounded pointer-events-none whitespace-nowrap z-50">
                  {port.label}
                </span>
              </div>
            );
        })}
      </div>

      {/* Outputs (Right) */}
      <div className="absolute top-[52px] -right-3 flex flex-col gap-[28px] pointer-events-none">
        {outputs.map((port) => {
            const connected = isConnected(port.id);
            return (
              <div 
                key={port.id} 
                className="relative group flex items-center justify-end h-3 pointer-events-auto"
                title={port.label}
              >
                 <span className="absolute right-4 text-[10px] text-zinc-500 uppercase tracking-tighter opacity-0 group-hover:opacity-100 transition-opacity bg-black/80 px-1 rounded pointer-events-none whitespace-nowrap z-50">
                  {port.label}
                </span>
                <div 
                  className={`w-3 h-3 border border-zinc-900 rounded-full transition-all cursor-crosshair nodrag ${
                    connected ? 'bg-yellow-500' : 'bg-zinc-600 hover:bg-zinc-400'
                  }`}
                  onPointerDown={(e) => onPortDown(e, port.id, data.id, false)}
                  onContextMenu={(e) => onPortContextMenu(e, port.id)}
                  data-port-id={port.id}
                  data-node-id={data.id}
                />
              </div>
            );
        })}
      </div>

      {/* Resize Handle */}
      <div 
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-center justify-center opacity-50 hover:opacity-100 nodrag z-20"
        onPointerDown={handleResizePointerDown}
      >
        <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full" />
      </div>
    </div>
  );
};