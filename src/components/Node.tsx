
import React, { useRef, useEffect, useState } from 'react';
import { NodeData, Position, Size } from '../types';
import { getPortsForNode } from '../constants';
import { Play, GripVertical, Pencil, Pause, RotateCcw, Plus, Send, Bot, User, FileCode, Loader2, ArrowRight, Package, Search, Download, Wand2, Sparkles, X, Image as ImageIcon, Square, Minus, Maximize2, Minimize2, StickyNote, Check, Lock, Folder, File } from 'lucide-react';
import Editor, { useMonaco } from '@monaco-editor/react';
import Markdown from 'markdown-to-jsx';

interface NodeProps {
  data: NodeData;
  isSelected: boolean;
  isHighlighted?: boolean;
  isRunning?: boolean;
  isMaximized?: boolean; 
  scale: number;
  pan: Position; // Needed for maximized offset calculation
  isConnected: (portId: string) => boolean;
  onMove: (id: string, pos: Position) => void;
  onResize: (id: string, size: Size) => void;
  onDelete: (id: string) => void;
  onToggleRun: (id: string) => void;
  onRefresh?: (id: string) => void;
  onPortDown: (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => void;
  onPortContextMenu: (e: React.MouseEvent, portId: string) => void;
  onContextMenu?: (e: React.MouseEvent | React.TouchEvent) => void; 
  onUpdateTitle: (id: string, title: string) => void;
  onUpdateContent?: (id: string, content: string) => void;
  onSendMessage?: (id: string, text: string) => void; 
  onStartContextSelection?: (id: string) => void; 
  onAiAction?: (nodeId: string, action: 'optimize' | 'prompt', prompt?: string) => void;
  onCancelAi?: (nodeId: string) => void; 
  onInjectImport?: (sourceNodeId: string, packageName: string) => void; 
  onFixError?: (nodeId: string, error: string) => void; 
  onInteraction?: (nodeId: string, type: 'drag' | 'edit' | null) => void;
  onToggleMinimize?: (id: string) => void;
  onToggleMaximize?: (id: string) => void;
  onDragEnd?: (id: string) => void; 
  onSelect?: (id: string, multi: boolean) => void; 
  collaboratorInfo?: { name: string; color: string; action: 'dragging' | 'editing' };
  logs?: any[]; 
  folderContents?: string[]; 
  children?: React.ReactNode;
}

export const Node = React.memo<NodeProps>(({
  data,
  isSelected,
  isHighlighted,
  isRunning = false,
  isMaximized = false,
  scale,
  pan,
  isConnected,
  onMove,
  onResize,
  onDelete,
  onToggleRun,
  onRefresh,
  onPortDown,
  onPortContextMenu,
  onContextMenu,
  onUpdateTitle,
  onUpdateContent,
  onSendMessage,
  onStartContextSelection,
  onAiAction,
  onCancelAi,
  onInjectImport,
  onFixError,
  onInteraction,
  onToggleMinimize,
  onToggleMaximize,
  onDragEnd,
  onSelect,
  collaboratorInfo,
  logs,
  folderContents,
  children
}) => {
  const ports = getPortsForNode(data.id, data.type);
  const inputs = ports.filter(p => p.type === 'input');
  const outputs = ports.filter(p => p.type === 'output');
  
  const nodeRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<any>(null);
  const contentHeightRef = useRef<number>(0);

  const MonacoEditor = Editor as any;
  
  // Track data in ref to avoid stale closures in callbacks
  const nodeDataRef = useRef(data);
  useEffect(() => {
      nodeDataRef.current = data;
  }, [data]);

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [tempTitle, setTempTitle] = useState(data.title);
  const [chatInput, setChatInput] = useState('');
  
  // Text Node State
  const [isEditingText, setIsEditingText] = useState(false);

  // AI States
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');

  // NPM States
  const [npmQuery, setNpmQuery] = useState(data.type === 'NPM' ? data.content : '');
  const [npmResults, setNpmResults] = useState<any[]>([]);
  const [isSearchingNpm, setIsSearchingNpm] = useState(false);

  // Image States
  const [isDragOver, setIsDragOver] = useState(false);

  const isLocked = !!data.lockedBy;

  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const initialPosRef = useRef<Position>({ x: 0, y: 0 });
  const initialSizeRef = useRef<Size>({ width: 0, height: 0 });
  
  // Mobile Long Press Timer
  const longPressTimer = useRef<any>(null);

  useEffect(() => {
    if (data.type === 'TERMINAL' && terminalContainerRef.current) {
        const el = terminalContainerRef.current;
        el.scrollTop = el.scrollHeight;
    }
  }, [logs, data.type]);

  // Sync actual rendered size back to state when minimized to ensure wires connect correctly
  useEffect(() => {
    if (data.isMinimized && nodeRef.current) {
        const actualWidth = nodeRef.current.offsetWidth;
        const actualHeight = nodeRef.current.offsetHeight;
        if (Math.abs(actualWidth - data.size.width) > 2 || Math.abs(actualHeight - data.size.height) > 2) {
            onResize(data.id, { width: actualWidth, height: actualHeight });
        }
    }
  }, [data.isMinimized, data.title, data.size.width, data.size.height, onResize, data.id]);

  // Auto-scroll chat to bottom
  useEffect(() => {
      if (data.type === 'AI_CHAT' && chatContainerRef.current) {
          const el = chatContainerRef.current;
          el.scrollTop = el.scrollHeight;
      }
  }, [data.messages, data.type, data.isLoading]);

  useEffect(() => {
    if (isPromptOpen && promptInputRef.current) {
        promptInputRef.current.focus();
    }
  }, [isPromptOpen]);

  useEffect(() => {
      if (isEditingText && textEditorRef.current) {
          textEditorRef.current.focus();
      }
  }, [isEditingText]);

  // Handle NPM Search Debounce/Content Update
  useEffect(() => {
      if (data.type === 'NPM') {
          if (data.content !== npmQuery) {
              setNpmQuery(data.content);
          }
      }
  }, [data.content, data.type]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isMaximized) return; 
    if (data.isLoading) {
        if ((e.target as HTMLElement).closest('.cancel-btn')) return;
        return; 
    }
    if ((e.target as HTMLElement).closest('.nodrag')) {
        return;
    }
    
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    // Initial drag state setup
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPosRef.current = { ...data.position };

    if (e.pointerType === 'mouse') {
        if (onSelect) {
            if (e.ctrlKey) {
                onSelect(data.id, true);
            } else if (!isSelected) {
                onSelect(data.id, false);
            }
        }
        setIsDragging(true);
        onInteraction?.(data.id, 'drag'); 
    } else {
        longPressTimer.current = setTimeout(() => {
            if (onContextMenu) {
                onContextMenu(e as any);
                dragStartRef.current = null;
                setIsDragging(false);
            }
            longPressTimer.current = null;
        }, 600);
    }

    if (!isPromptOpen) setIsPromptOpen(false);
  };

  const handleResizePointerDown = (e: React.PointerEvent) => {
    if (data.isLoading || data.isMinimized || isMaximized) return; 
    
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsResizing(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialSizeRef.current = { ...data.size };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;

    if (e.pointerType !== 'mouse' && !isDragging && !isResizing) {
        const dist = Math.hypot(e.clientX - dragStartRef.current.x, e.clientY - dragStartRef.current.y);
        if (dist > 10) {
            if (longPressTimer.current) {
                clearTimeout(longPressTimer.current);
                longPressTimer.current = null;
            }
            setIsDragging(true);
            onInteraction?.(data.id, 'drag');
        } else {
            return; 
        }
    }

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
      
      const newWidth = Math.max(250, initialSizeRef.current.width + dx);
      let newHeight = Math.max(150, initialSizeRef.current.height + dy);

      if (data.type === 'CODE' && contentHeightRef.current > 0) {
          const HEADER_HEIGHT = 40;
          const PADDING = 20; 
          const maxAllowedHeight = Math.max(150, contentHeightRef.current + HEADER_HEIGHT + PADDING);
          if (newHeight > maxAllowedHeight) {
              newHeight = maxAllowedHeight;
          }
      }

      onResize(data.id, {
        width: newWidth,
        height: newHeight,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' && longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        if (!isDragging && onSelect) {
            onSelect(data.id, true);
        }
    }

    if (isDragging) {
        onInteraction?.(data.id, null); 
        onDragEnd?.(data.id);
    }
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

  const handleCancelAi = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onCancelAi) onCancelAi(data.id);
  };

  const handleAiClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (data.isLoading) {
          if (onCancelAi) onCancelAi(data.id);
      } else {
          setIsPromptOpen(!isPromptOpen);
          setPromptText('');
      }
  };

  const submitPrompt = () => {
      if (promptText.trim()) {
          onAiAction?.(data.id, 'prompt', promptText);
          setIsPromptOpen(false);
          setPromptText('');
      }
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitPrompt();
      }
      if (e.key === 'Escape') {
          setIsPromptOpen(false);
      }
  };

  const handleFormatCode = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (editorRef.current) {
          editorRef.current.getAction('editor.action.formatDocument').run();
      }
  };

  const handleToggleMinimize = (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleMinimize?.(data.id);
  };

  const handleToggleMaximize = (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleMaximize?.(data.id);
  };

  const handleEditorMount = (editor: any) => {
      editorRef.current = editor;
      editor.onDidFocusEditorText(() => {
          onInteraction?.(data.id, 'edit');
      });
      editor.onDidBlurEditorText(() => {
          onInteraction?.(data.id, null);
      });

      if (data.type === 'CODE') {
          editor.onDidContentSizeChange((e: any) => {
              contentHeightRef.current = e.contentHeight;
              const currentNode = nodeDataRef.current;
              const HEADER_HEIGHT = 40;
              const MIN_HEIGHT = 150;
              const PADDING = 20; 
              const fitHeight = Math.max(MIN_HEIGHT, e.contentHeight + HEADER_HEIGHT + PADDING);
              
              if (currentNode.autoHeight) {
                  if (Math.abs(fitHeight - currentNode.size.height) > 3) {
                      onResize(currentNode.id, { width: currentNode.size.width, height: fitHeight });
                  }
              } else {
                  if (currentNode.size.height > fitHeight + 5) {
                      onResize(currentNode.id, { width: currentNode.size.width, height: fitHeight });
                  }
              }
          });
      }
  };

  const getLanguage = (filename: string) => {
      if (filename.endsWith('.css')) return 'css';
      if (filename.endsWith('.html')) return 'html';
      if (filename.endsWith('.json')) return 'json';
      return 'javascript';
  };

  const searchNpm = async () => {
      if (!npmQuery.trim()) return;
      setIsSearchingNpm(true);
      if (onUpdateContent) onUpdateContent(data.id, npmQuery); 
      try {
          const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(npmQuery)}&size=5`);
          const json = await res.json();
          setNpmResults(json.objects || []);
      } catch (e) {
          console.error(e);
      } finally {
          setIsSearchingNpm(false);
      }
  };

  const handleNpmSearchKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') searchNpm();
  };

  const handleInjectPackage = (pkgName: string) => {
      if (onInjectImport) {
          onInjectImport(data.id, pkgName);
      }
  };

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
  };
  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/') && onUpdateContent) {
          const reader = new FileReader();
          reader.onload = (event) => {
              const img = new Image();
              img.onload = () => {
                  const canvas = document.createElement('canvas');
                  const MAX_SIZE = 800; 
                  let width = img.width;
                  let height = img.height;
                  
                  if (width > height) {
                      if (width > MAX_SIZE) {
                          height *= MAX_SIZE / width;
                          width = MAX_SIZE;
                      }
                  } else {
                      if (height > MAX_SIZE) {
                          width *= MAX_SIZE / height;
                          height = MAX_SIZE;
                      }
                  }
                  
                  canvas.width = width;
                  canvas.height = height;
                  const ctx = canvas.getContext('2d');
                  ctx?.drawImage(img, 0, 0, width, height);
                  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
                  onUpdateContent(data.id, dataUrl);
                  onUpdateTitle(data.id, file.name);
              };
              if (typeof event.target?.result === 'string') {
                  img.src = event.target.result;
              }
          };
          reader.readAsDataURL(file);
      }
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey)) {
          const key = e.key.toLowerCase();
          if (['b', 'i', 'u'].includes(key)) {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const text = el.value;
              const selection = text.substring(start, end);
              
              let wrapped = selection;
              let wrapperLen = 0;

              if (key === 'b') {
                  wrapped = `**${selection}**`;
                  wrapperLen = 2;
              } else if (key === 'i') {
                  wrapped = `*${selection}*`;
                  wrapperLen = 1;
              } else if (key === 'u') {
                  wrapped = `<u>${selection}</u>`;
                  wrapperLen = 3;
              }

              const newText = text.substring(0, start) + wrapped + text.substring(end);
              if (onUpdateContent) onUpdateContent(data.id, newText);
              
              setTimeout(() => {
                  if (textEditorRef.current) {
                      textEditorRef.current.selectionStart = start + wrapperLen;
                      textEditorRef.current.selectionEnd = end + wrapperLen;
                  }
              }, 0);
          }
      }
  };

  let borderClass = 'border-panelBorder';
  let shadowClass = '';
  
  const shimmerOverlay = data.isLoading ? (
      <div className="absolute inset-0 z-50 pointer-events-none rounded-lg overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent animate-shimmer" style={{ width: '200%' }} />
          <div className="absolute inset-0 ring-2 ring-indigo-500/50 rounded-lg" />
      </div>
  ) : null;

  if (collaboratorInfo) {
      borderClass = `border-[${collaboratorInfo.color}]`;
      shadowClass = `shadow-[0_0_15px_${collaboratorInfo.color}40]`;
  } else if (isHighlighted) {
      borderClass = 'border-yellow-500';
      shadowClass = 'shadow-[0_0_30px_rgba(234,179,8,0.6)]';
  } else if (isSelected) {
      borderClass = 'border-accent';
      shadowClass = 'shadow-accent/20';
  } else if (data.isLoading) {
      borderClass = 'border-indigo-500/50';
  }

  // MAXIMIZATION: Counter-transform to fill viewport while staying in component tree
  const maximizedStyle = isMaximized ? {
      position: 'absolute' as const,
      top: `${-pan.y / scale}px`,
      left: `${-pan.x / scale}px`,
      width: `calc(100vw / ${scale})`,
      height: `calc(100vh / ${scale})`,
      zIndex: 9999,
      transform: 'none', // Reset node's own position transform
      borderWidth: 0,
      borderRadius: 0,
  } : {
      transform: `translate(${data.position.x}px, ${data.position.y}px)`,
      width: data.isMinimized ? 'auto' : data.size.width, 
      minWidth: data.isMinimized ? '200px' : undefined,
      height: data.isMinimized ? 'auto' : data.size.height,
  };

  const dynamicStyle = collaboratorInfo ? {
      borderColor: collaboratorInfo.color,
      boxShadow: `0 0 15px ${collaboratorInfo.color}40`
  } : {};

  return (
    <div
      ref={nodeRef}
      data-node-id={data.id}
      className={`absolute flex flex-col bg-panel border rounded-lg shadow-2xl animate-in fade-in zoom-in-95 pointer-events-auto ${!collaboratorInfo && !isMaximized && borderClass} ${!collaboratorInfo && !isMaximized && shadowClass}`}
      style={{
        ...maximizedStyle,
        transitionProperty: isMaximized ? 'all' : 'box-shadow, border-color, transform, width, height', 
        transitionDuration: (isDragging || isResizing) ? '0s' : '0.2s',
        transitionTimingFunction: 'ease-out',
        ...dynamicStyle
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {shimmerOverlay}

      {/* Header */}
      <div className={`h-10 flex items-center justify-between px-3 border-b border-panelBorder bg-zinc-900/50 rounded-t-lg select-none shrink-0 relative z-10 gap-3 ${data.isMinimized ? 'rounded-b-lg border-b-0' : ''}`}>
        <div className={`flex items-center gap-2 text-zinc-300 font-semibold text-sm min-w-0 ${data.isMinimized ? 'whitespace-nowrap' : 'flex-1'}`}>
          {!isMaximized && <GripVertical size={14} className="opacity-50 shrink-0" />}
          {isEditingTitle && !isMaximized ? (
            <input 
              type="text" 
              value={tempTitle}
              onChange={(e) => setTempTitle(e.target.value)}
              onBlur={finishEditing}
              onKeyDown={(e) => e.key === 'Enter' && finishEditing()}
              onPointerDown={(e) => e.stopPropagation()} 
              className="bg-black border border-zinc-700 rounded px-1 py-0.5 text-xs w-full nodrag text-white focus:outline-none focus:border-accent select-text font-medium"
              autoFocus
            />
          ) : (
             <div className={`flex items-center gap-2 group/title ${data.isMinimized ? 'whitespace-nowrap' : 'truncate'}`}>
                {data.lockedBy && (
                    <div className="text-amber-500 flex items-center" title={`Locked by ${data.lockedBy.displayName}`}>
                        <Lock size={12} />
                    </div>
                )}
                {data.type === 'AI_CHAT' && <Bot size={14} className="text-indigo-400" />}
                {data.type === 'NPM' && <Package size={14} className="text-red-500" />}
                {data.type === 'IMAGE' && <ImageIcon size={14} className="text-purple-400" />}
                {data.type === 'TEXT' && <StickyNote size={14} className="text-emerald-400" />}
                {data.type === 'FOLDER' && <Folder size={14} className="text-orange-400" />}
                <span className={data.isMinimized ? 'whitespace-nowrap' : 'truncate'}>{data.title}</span>
                {!isMaximized && (
                    <button 
                        onClick={(e) => { e.stopPropagation(); setIsEditingTitle(true); }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="opacity-0 group-hover/title:opacity-100 p-1 hover:bg-zinc-800 rounded text-zinc-500 hover:text-zinc-300 transition-all nodrag shrink-0 active:scale-90 transition-transform"
                        disabled={data.isLoading}
                    >
                        <Pencil size={12} />
                    </button>
                )}
             </div>
          )}
        </div>
        
        <div className="flex items-center gap-1 shrink-0">
           {data.type === 'CODE' && (
              <div className="flex items-center gap-1">
                 <button
                    onClick={handleToggleMinimize}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 transition-transform"
                    title={data.isMinimized ? "Expand" : "Minimize"}
                 >
                     {data.isMinimized ? <Square size={14} /> : <Minus size={14} />}
                 </button>

                 <button
                    onClick={handleFormatCode}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 transition-transform"
                    title="Format Code"
                    disabled={data.isLoading}
                 >
                     <Wand2 size={14} />
                 </button>

                 <div className="relative">
                     <button
                        onClick={handleAiClick}
                        onPointerDown={(e) => e.stopPropagation()}
                        className={`nodrag cancel-btn p-1.5 rounded transition-all cursor-pointer relative z-10 flex items-center gap-1 active:scale-90 transition-transform ${
                            isPromptOpen || data.isLoading ? 'bg-blue-500/20 text-blue-400' : 'text-zinc-400 hover:text-blue-400 hover:bg-zinc-800'
                        }`}
                        title={data.isLoading ? "Stop Generating" : "AI Assistant"}
                     >
                        {data.isLoading ? (
                            <div className="group/cancel relative w-[14px] h-[14px]">
                                <Loader2 size={14} className="animate-spin absolute inset-0 opacity-100 group-hover/cancel:opacity-0 transition-opacity" />
                                <Square size={14} className="fill-current absolute inset-0 opacity-0 group-hover/cancel:opacity-100 transition-opacity" />
                            </div>
                        ) : (
                            <Sparkles size={14} fill={isPromptOpen ? "currentColor" : "none"} />
                        )}
                     </button>
                 </div>
              </div>
           )}

           {data.type === 'PREVIEW' && (
             <div className="flex items-center gap-1">
               <button 
                  onClick={handleRefreshClick}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 transition-transform"
                  title="Refresh"
                >
                   <RotateCcw size={14} />
               </button>
               <button 
                  onClick={handleRunClick}
                  onPointerDown={(e) => e.stopPropagation()}
                  className={`nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 active:scale-90 transition-transform ${
                      isRunning ? 'text-yellow-500 hover:bg-yellow-500/20' : 'text-green-500 hover:bg-green-500/20'
                  }`}
                  title={isRunning ? "Stop" : "Run"}
              >
                  {isRunning ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </button>
              <button
                onClick={handleToggleMaximize}
                onPointerDown={(e) => e.stopPropagation()}
                className="nodrag p-1.5 rounded transition-colors cursor-pointer relative z-10 text-zinc-400 hover:text-white hover:bg-zinc-800 active:scale-90 transition-transform"
                title={isMaximized ? "Restore" : "Maximize"}
              >
                  {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          )}
        </div>
      </div>

       {/* Floating Prompt Input */}
       {isPromptOpen && (
          <div className="px-2 pt-2 pb-1 bg-zinc-900/90 backdrop-blur border-b border-panelBorder animate-in slide-in-from-top-2 duration-200 z-30 nodrag">
              <div className="relative">
                  <textarea
                    ref={promptInputRef}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder="Type instructions... (Shift+Enter for new line)"
                    className="w-full bg-zinc-950 border border-blue-500/30 rounded-md p-2 text-xs text-zinc-200 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none custom-scrollbar"
                    style={{ minHeight: '60px' }}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                  <button 
                    onClick={submitPrompt}
                    className="absolute bottom-2 right-2 p-1 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                    title="Generate"
                  >
                      <ArrowRight size={12} />
                  </button>
              </div>
          </div>
      )}

      {/* Content Area */}
      <div className={`flex-1 relative group nodrag flex flex-col min-h-0 overflow-hidden ${data.isMinimized ? 'hidden' : ''}`}>
        {/* ... (Existing Content Logic - Rendered as before) ... */}
        {data.type === 'CODE' ? (
            <div className="w-full h-full bg-[#1e1e1e]" onPointerDown={(e) => e.stopPropagation()}>
                 <MonacoEditor
                    height="100%"
                    defaultLanguage={getLanguage(data.title)}
                    language={getLanguage(data.title)}
                    value={data.content}
                    theme="vs-dark"
                    onChange={(value: string | undefined) => onUpdateContent?.(data.id, value || '')}
                    onMount={handleEditorMount}
                    options={{
                        minimap: { enabled: true, scale: 0.5 },
                        fontSize: 13,
                        fontFamily: '"JetBrains Mono", monospace',
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        tabSize: 2,
                        wordWrap: 'on',
                        padding: { top: 10, bottom: 10 },
                    }}
                 />
            </div>
        ) : data.type === 'NPM' ? (
             <div className="flex flex-col h-full bg-zinc-900/50">
                 <div className="p-3 border-b border-panelBorder flex gap-2">
                     <div className="relative flex-1">
                        <Search size={14} className="absolute left-2.5 top-2.5 text-zinc-500" />
                        <input 
                            type="text" 
                            className="w-full bg-zinc-950 border border-zinc-700 rounded pl-8 pr-2 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                            placeholder="Search npm..."
                            value={npmQuery}
                            onChange={(e) => setNpmQuery(e.target.value)}
                            onKeyDown={handleNpmSearchKeyDown}
                            onPointerDown={(e) => e.stopPropagation()}
                        />
                     </div>
                     <button 
                        onClick={searchNpm} 
                        className="bg-red-600 hover:bg-red-500 text-white p-2 rounded transition-colors"
                        disabled={isSearchingNpm}
                        onPointerDown={(e) => e.stopPropagation()}
                     >
                         {isSearchingNpm ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                     </button>
                 </div>
                 <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
                     {npmResults.map((pkg: any) => (
                         <div key={pkg.package.name} className="bg-zinc-800 p-2 rounded border border-zinc-700 hover:border-zinc-500 transition-colors flex justify-between items-start group">
                             <div>
                                 <div className="font-bold text-zinc-200 text-xs">{pkg.package.name}</div>
                                 <div className="text-[10px] text-zinc-500 truncate max-w-[160px]">{pkg.package.description}</div>
                             </div>
                             <button 
                                onClick={() => handleInjectPackage(pkg.package.name)}
                                className="p-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
                                title="Inject Import into connected Code"
                                onPointerDown={(e) => e.stopPropagation()}
                             >
                                 <Download size={14} />
                             </button>
                         </div>
                     ))}
                     {npmResults.length === 0 && !isSearchingNpm && (
                         <div className="text-center text-zinc-600 text-xs mt-10 italic">
                             Search for packages to add imports.
                         </div>
                     )}
                 </div>
             </div>
        ) : data.type === 'TERMINAL' ? (
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
        ) : data.type === 'IMAGE' ? (
            <div 
                className={`w-full h-full bg-zinc-950 flex flex-col items-center justify-center relative overflow-hidden transition-colors ${
                    isDragOver ? 'bg-indigo-500/20 border-2 border-dashed border-indigo-500' : ''
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {data.content ? (
                    <img src={data.content} alt={data.title} className="max-w-full max-h-full object-contain pointer-events-none" />
                ) : (
                    <div className="text-zinc-600 text-center pointer-events-none">
                        <ImageIcon size={32} className="mx-auto mb-2 opacity-50" />
                        <p className="text-xs">Drag & Drop Image</p>
                    </div>
                )}
            </div>
        ) : data.type === 'TEXT' ? (
            <div className="w-full h-full bg-zinc-900 overflow-hidden flex flex-col group/text">
                {isEditingText ? (
                    <textarea
                        ref={textEditorRef}
                        className="flex-1 w-full h-full bg-zinc-900 p-4 text-sm text-zinc-200 focus:outline-none resize-none font-mono"
                        value={data.content}
                        onChange={(e) => onUpdateContent?.(data.id, e.target.value)}
                        onBlur={() => setIsEditingText(false)}
                        onKeyDown={handleTextKeyDown}
                        placeholder="# Title..."
                        onPointerDown={(e) => e.stopPropagation()}
                    />
                ) : (
                    <div 
                        className="flex-1 w-full h-full p-4 overflow-y-auto custom-scrollbar prose prose-invert prose-sm max-w-none select-text"
                        onDoubleClick={() => setIsEditingText(true)}
                        onPointerDown={(e) => e.stopPropagation()}
                    >
                        {data.content ? (
                            <Markdown options={{ forceBlock: true }}>{data.content}</Markdown>
                        ) : (
                            <p className="text-zinc-600 italic">Double-click to edit...</p>
                        )}
                    </div>
                )}
                {!isEditingText && (
                    <button 
                        onClick={() => setIsEditingText(true)}
                        className="absolute bottom-3 right-3 p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-full shadow-lg opacity-0 group-hover/text:opacity-100 transition-opacity"
                    >
                        <Pencil size={14} />
                    </button>
                )}
            </div>
        ) : data.type === 'FOLDER' ? (
            <div className="w-full h-full bg-zinc-900/50 p-2 overflow-y-auto custom-scrollbar">
                {folderContents && folderContents.length > 0 ? (
                    <div className="flex flex-col gap-1">
                        {folderContents.map((fileName, idx) => (
                            <div key={idx} className="flex items-center gap-2 p-2 bg-zinc-800/50 rounded hover:bg-zinc-700/50 transition-colors group/file cursor-default">
                                <FileCode size={14} className="text-zinc-500 group-hover/file:text-zinc-300" />
                                <span className="text-xs text-zinc-400 truncate w-full">{fileName}</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-zinc-600 gap-2 opacity-50">
                        <Folder size={32} />
                        <span className="text-xs">Empty Folder</span>
                    </div>
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
        )}
      </div>

      {/* FIX 1a: Inputs (Left) - Adjust Position if Minimized */}
      <div className={`absolute ${data.isMinimized ? 'top-[20px]' : 'top-[52px]'} -left-3 flex flex-col gap-[28px] pointer-events-none`}>
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

      {/* FIX 1a: Outputs (Right) - Adjust Position if Minimized */}
      <div className={`absolute ${data.isMinimized ? 'top-[20px]' : 'top-[52px]'} -right-3 flex flex-col gap-[28px] pointer-events-none`}>
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
      {!data.isMinimized && !isMaximized && (
          <div 
            className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize flex items-center justify-center opacity-50 hover:opacity-100 nodrag z-20"
            onPointerDown={handleResizePointerDown}
          >
            <div className="w-1.5 h-1.5 bg-zinc-500 rounded-full" />
          </div>
      )}
    </div>
  );
});
