
import React, { useRef, useEffect, useState } from 'react';
import { NodeData, Position, Size } from '../types';
import { getPortsForNode } from '../constants';
import { Play, GripVertical, Pencil, Pause, RotateCcw, Plus, Send, Bot, User, FileCode, Loader2, ArrowRight, Package, Search, Download, Wand2, Sparkles, X, Image as ImageIcon, Square, Minus, Maximize2, Minimize2 } from 'lucide-react';
import Editor, { useMonaco } from '@monaco-editor/react';

interface NodeProps {
  data: NodeData;
  isSelected: boolean;
  isHighlighted?: boolean;
  isRunning?: boolean;
  isMaximized?: boolean; // New Prop
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
  onUpdateContent?: (id: string, content: string) => void;
  onSendMessage?: (id: string, text: string) => void; 
  onStartContextSelection?: (id: string) => void; 
  onAiAction?: (nodeId: string, action: 'optimize' | 'prompt', prompt?: string) => void;
  onCancelAi?: (nodeId: string) => void; 
  onInjectImport?: (sourceNodeId: string, packageName: string) => void; 
  onFixError?: (nodeId: string, error: string) => void; 
  onInteraction?: (nodeId: string, type: 'drag' | 'edit' | null) => void;
  onToggleMinimize?: (id: string) => void;
  onToggleMaximize?: (id: string) => void; // New Prop
  onDragEnd?: (id: string) => void; 
  onSelect?: (id: string, multi: boolean) => void; 
  collaboratorInfo?: { name: string; color: string; action: 'dragging' | 'editing' };
  logs?: any[]; 
  children?: React.ReactNode;
}

export const Node: React.FC<NodeProps> = ({
  data,
  isSelected,
  isHighlighted,
  isRunning = false,
  isMaximized = false,
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
  children
}) => {
  const ports = getPortsForNode(data.id, data.type);
  const inputs = ports.filter(p => p.type === 'input');
  const outputs = ports.filter(p => p.type === 'output');
  
  const nodeRef = useRef<HTMLDivElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<any>(null);
  const contentHeightRef = useRef<number>(0);
  
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
  
  // AI States
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');

  // NPM States
  const [npmQuery, setNpmQuery] = useState(data.type === 'NPM' ? data.content : '');
  const [npmResults, setNpmResults] = useState<any[]>([]);
  const [isSearchingNpm, setIsSearchingNpm] = useState(false);

  // Image States
  const [isDragOver, setIsDragOver] = useState(false);

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

  useEffect(() => {
    if (isPromptOpen && promptInputRef.current) {
        promptInputRef.current.focus();
    }
  }, [isPromptOpen]);

  // Handle NPM Search Debounce/Content Update
  useEffect(() => {
      if (data.type === 'NPM') {
          if (data.content !== npmQuery) {
              setNpmQuery(data.content);
          }
      }
  }, [data.content, data.type]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isMaximized) return; // Disable dragging if maximized
    if (data.isLoading) {
        if ((e.target as HTMLElement).closest('.cancel-btn')) return;
        return; 
    }
    if ((e.target as HTMLElement).closest('.nodrag')) {
        return;
    }
    
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    // Selection Logic
    if (onSelect) {
        if (e.ctrlKey) {
            onSelect(data.id, true);
        } else if (!isSelected) {
            onSelect(data.id, false);
        }
    }

    setIsDragging(true);
    onInteraction?.(data.id, 'drag'); 
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialPosRef.current = { ...data.position };

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

      // Auto-Size Logic
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

  // NPM Logic
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

  // Styles
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

  // Maximized Style Override
  const maximizedStyle = isMaximized ? {
      position: 'fixed' as const,
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      zIndex: 9999,
      transform: 'none',
      borderRadius: 0,
      borderWidth: 0,
  } : {
      transform: `translate(${data.position.x}px, ${data.position.y}px)`,
      width: data.isMinimized ? '250px' : data.size.width,
      height: data.isMinimized ? '40px' : data.size.height,
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

      {/* Collaborator Badge (Hidden if Maximized) */}
      {collaboratorInfo && !isMaximized && (
          <div 
            className="absolute -top-6 right-0 px-2 py-0.5