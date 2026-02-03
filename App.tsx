import React, { useReducer, useState, useRef, useEffect } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { GraphState, Action, NodeData, NodeType, LogEntry } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition } from './utils/graphUtils';
import { Trash2 } from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';

const STORAGE_KEY = 'nodecode-studio-v1';

const initialState: GraphState = {
  nodes: [],
  connections: [],
  pan: { x: 0, y: 0 },
  zoom: 1,
  logs: {},
};

function graphReducer(state: GraphState, action: Action): GraphState {
  switch (action.type) {
    case 'ADD_NODE':
      return { ...state, nodes: [...state.nodes, action.payload] };
    case 'DELETE_NODE':
      return {
        ...state,
        nodes: state.nodes.filter(n => n.id !== action.payload),
        connections: state.connections.filter(c => c.sourceNodeId !== action.payload && c.targetNodeId !== action.payload),
        logs: { ...state.logs, [action.payload]: [] }
      };
    case 'UPDATE_NODE_POSITION':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, position: action.payload.position } : n)
      };
    case 'UPDATE_NODE_SIZE':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, size: action.payload.size } : n)
      };
    case 'UPDATE_NODE_CONTENT':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, content: action.payload.content } : n)
      };
    case 'UPDATE_NODE_TITLE':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, title: action.payload.title } : n)
      };
    case 'CONNECT':
      const { sourceNodeId, sourcePortId, targetNodeId, targetPortId } = action.payload;
      
      const exists = state.connections.some(c => 
        c.sourceNodeId === sourceNodeId && 
        c.sourcePortId === sourcePortId && 
        c.targetNodeId === targetNodeId && 
        c.targetPortId === targetPortId
      );
      if (exists) return state;

      const isSingleInputPort = targetPortId.includes('in-dom');
      if (isSingleInputPort && state.connections.some(c => c.targetPortId === targetPortId)) {
        return state;
      }
      
      return { ...state, connections: [...state.connections, action.payload] };
      
    case 'DISCONNECT':
      return { 
          ...state, 
          connections: state.connections.filter(c => c.sourcePortId !== action.payload && c.targetPortId !== action.payload) 
      };
    case 'PAN':
      return { ...state, pan: action.payload };
    case 'ZOOM':
      return { ...state, zoom: action.payload.zoom };
    case 'ADD_LOG':
      return {
        ...state,
        logs: {
          ...state.logs,
          [action.payload.nodeId]: [...(state.logs[action.payload.nodeId] || []), action.payload.log]
        }
      };
    case 'CLEAR_LOGS':
      return {
        ...state,
        logs: { ...state.logs, [action.payload.nodeId]: [] }
      };
    case 'LOAD_STATE':
        return { ...initialState, ...action.payload, logs: {} };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, targetNodeId?: string, targetPortId?: string } | null>(null);
  
  const [dragWire, setDragWire] = useState<{ x1: number, y1: number, x2: number, y2: number, startPortId: string, startNodeId: string, isInput: boolean } | null>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { dispatch({ type: 'LOAD_STATE', payload: JSON.parse(saved) }); } catch (e) {}
    } else {
        const codeDefaults = NODE_DEFAULTS.CODE;
        const previewDefaults = NODE_DEFAULTS.PREVIEW;

        dispatch({ type: 'ADD_NODE', payload: { id: 'node-1', type: 'CODE', position: { x: 100, y: 100 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'index.html', content: '<h1>Hello World</h1>\n<link href="style.css" rel="stylesheet">\n<script src="app.js"></script>' } });
        dispatch({ type: 'ADD_NODE', payload: { id: 'node-2', type: 'CODE', position: { x: 100, y: 300 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'style.css', content: 'body { background: #222; color: #fff; }' } });
        dispatch({ type: 'ADD_NODE', payload: { id: 'node-3', type: 'PREVIEW', position: { x: 600, y: 100 }, size: { width: previewDefaults.width, height: previewDefaults.height }, title: previewDefaults.title, content: previewDefaults.content } });
    }
    initialized.current = true;
  }, []);

  useEffect(() => {
    if (!initialized.current) return;
    const timer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: state.nodes, connections: state.connections, pan: state.pan, zoom: state.zoom }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.nodes, state.connections, state.pan, state.zoom]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.source === 'preview-iframe' && data.nodeId) {
        dispatch({ type: 'ADD_LOG', payload: { nodeId: data.nodeId, log: { type: data.type, message: data.message, timestamp: data.timestamp } } });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, nodeId?: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, targetNodeId: nodeId });
  };

  const handlePortContextMenu = (e: React.MouseEvent, portId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId)) {
        setContextMenu({ x: e.clientX, y: e.clientY, targetPortId: portId });
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('.custom-scrollbar')) return;
    
    // Zoom toward cursor
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Convert mouse to world space before zoom
    const worldX = (mouseX - state.pan.x) / state.zoom;
    const worldY = (mouseY - state.pan.y) / state.zoom;

    const zoomIntensity = 0.001;
    const newZoom = Math.min(Math.max(0.1, state.zoom - e.deltaY * zoomIntensity), 3);

    // Calculate new pan to keep world point under mouse
    const newPanX = mouseX - worldX * newZoom;
    const newPanY = mouseY - worldY * newZoom;

    dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
    dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
  };

  const handleAddNode = (type: NodeType) => {
    if (!contextMenu) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (contextMenu.x - rect.left - state.pan.x) / state.zoom;
    const y = (contextMenu.y - rect.top - state.pan.y) / state.zoom;
    const defaults = NODE_DEFAULTS[type];
    const newNode: NodeData = {
      id: `node-${Date.now()}`,
      type,
      title: defaults.title,
      content: defaults.content,
      position: { x, y },
      size: { width: defaults.width, height: defaults.height },
    };
    dispatch({ type: 'ADD_NODE', payload: newNode });
    setContextMenu(null);
  };

  const handleRun = (id: string) => {
    const node = state.nodes.find(n => n.id === id);
    if (!node) return;
    const triggerUpdate = (targetId: string) => {
      const targetNode = state.nodes.find(n => n.id === targetId);
      if (!targetNode) return;
      if (targetNode.type === 'PREVIEW') {
        const compiled = compilePreview(targetId, state.nodes, state.connections);
        const iframe = document.getElementById(`preview-iframe-${targetId}`) as HTMLIFrameElement;
        if (iframe) {
           dispatch({ type: 'CLEAR_LOGS', payload: { nodeId: targetId } });
           iframe.srcdoc = compiled;
        }
      }
    };
    if (node.type === 'PREVIEW') {
      triggerUpdate(node.id);
    } else {
      const downstreamConnections = state.connections.filter(c => c.sourceNodeId === id);
      downstreamConnections.forEach(c => triggerUpdate(c.targetNodeId));
    }
  };

  const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Use the explicitly passed nodeId which is robust against ID formats
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) {
        console.error("Node not found for drag", nodeId);
        return;
    }

    const pos = calculatePortPosition(node, portId, isInput ? 'input' : 'output');
    
    setDragWire({
        x1: pos.x,
        y1: pos.y,
        x2: pos.x,
        y2: pos.y,
        startPortId: portId,
        startNodeId: nodeId,
        isInput
    });
    
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragWire && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
        const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
        setDragWire(prev => prev ? { ...prev, x2: x, y2: y } : null);
    } else if (e.buttons === 1 && (e.target as HTMLElement).id === 'canvas-bg') {
        dispatch({ type: 'PAN', payload: { x: state.pan.x + e.movementX, y: state.pan.y + e.movementY } });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragWire) return;
    
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const portEl = targetEl?.closest('[data-port-id]');
    
    if (portEl) {
        const endPortId = portEl.getAttribute('data-port-id');
        const endNodeId = portEl.getAttribute('data-node-id'); // Use explicit data attribute

        if (endPortId && endNodeId && endPortId !== dragWire.startPortId) {
            const isStartInput = dragWire.isInput;
            const isTargetInput = endPortId.includes('-in-'); // Convention still useful for type check
            
            if (isStartInput !== isTargetInput && dragWire.startNodeId !== endNodeId) {
                dispatch({
                    type: 'CONNECT',
                    payload: {
                        id: `conn-${Date.now()}`,
                        sourceNodeId: isStartInput ? endNodeId : dragWire.startNodeId,
                        sourcePortId: isStartInput ? endPortId : dragWire.startPortId,
                        targetNodeId: isStartInput ? dragWire.startNodeId : endNodeId,
                        targetPortId: isStartInput ? dragWire.startPortId : endPortId
                    }
                });
            }
        }
    }

    setDragWire(null);
  };

  const isConnected = (portId: string) => {
      return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
  };

  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none">
        <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">NodeCode Studio</h1>
        <p className="text-xs text-zinc-500">Drag ports to connect. Right-click connected ports to disconnect.</p>
      </div>

      <div className="absolute top-4 right-4 z-50">
        <button 
            onClick={() => { if(confirm('Reset?')) { localStorage.removeItem(STORAGE_KEY); window.location.reload(); } }}
            className="px-3 py-1.5 bg-zinc-900/80 hover:bg-red-900/50 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center gap-2 transition-colors"
        >
            <Trash2 size={12} /> Reset
        </button>
      </div>

      <div 
        ref={containerRef}
        id="canvas-bg"
        className="flex-1 relative cursor-grab active:cursor-grabbing"
        onContextMenu={(e) => handleContextMenu(e)}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        style={{
            backgroundImage: 'radial-gradient(#27272a 1px, transparent 1px)',
            backgroundSize: `${20 * state.zoom}px ${20 * state.zoom}px`,
            backgroundPosition: `${state.pan.x}px ${state.pan.y}px`,
        }}
      >
        <div 
            style={{ 
                transform: `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`,
                transformOrigin: '0 0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none'
            }}
        >
            <div className="pointer-events-auto w-full h-full relative">
                {/* Wires - Established connections at bottom */}
                <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                    {state.connections.map(conn => {
                        const sourceNode = state.nodes.find(n => n.id === conn.sourceNodeId);
                        const targetNode = state.nodes.find(n => n.id === conn.targetNodeId);
                        if (!sourceNode || !targetNode) return null;
                        const start = calculatePortPosition(sourceNode, conn.sourcePortId, 'output');
                        const end = calculatePortPosition(targetNode, conn.targetPortId, 'input');
                        return <Wire key={conn.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
                    })}
                </svg>

                {/* Nodes - Middle Layer */}
                {state.nodes.map(node => {
                    let logs: LogEntry[] = [];
                    if (node.type === 'TERMINAL') {
                         const sources = state.connections.filter(c => c.targetNodeId === node.id).map(c => c.sourceNodeId);
                         logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                    }
                    return (
                        <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                            <Node
                                data={node}
                                isSelected={false}
                                scale={state.zoom}
                                isConnected={isConnected}
                                onMove={(id, pos) => dispatch({ type: 'UPDATE_NODE_POSITION', payload: { id, position: pos } })}
                                onResize={(id, size) => dispatch({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                onDelete={(id) => dispatch({ type: 'DELETE_NODE', payload: id })}
                                onRun={handleRun}
                                onPortDown={handlePortDown}
                                onPortContextMenu={handlePortContextMenu}
                                onUpdateTitle={(id, title) => dispatch({ type: 'UPDATE_NODE_TITLE', payload: { id, title } })}
                                logs={logs}
                            >
                                {(node.type === 'CODE') && (
                                    <Editor
                                        value={node.content}
                                        onValueChange={code => dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: node.id, content: code } })}
                                        highlight={code => Prism.highlight(code, Prism.languages.markup, 'markup')}
                                        padding={12}
                                        style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 13, lineHeight: '1.5' }}
                                        className="min-h-full"
                                        textareaClassName="focus:outline-none whitespace-pre"
                                    />
                                )}
                            </Node>
                        </div>
                    );
                })}

                {/* Dragging Wire - Top Layer */}
                {dragWire && (
                    <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none" style={{ zIndex: 999 }}>
                        <Wire x1={dragWire.x1} y1={dragWire.y1} x2={dragWire.x2} y2={dragWire.y2} active />
                    </svg>
                )}
            </div>
        </div>
      </div>

      {contextMenu && (
        <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
            <ContextMenu 
                position={contextMenu} 
                targetNodeId={contextMenu.targetNodeId}
                targetPortId={contextMenu.targetPortId}
                onAdd={handleAddNode} 
                onDeleteNode={(id) => { dispatch({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); }}
                onDuplicateNode={(id) => { 
                    const node = state.nodes.find(n => n.id === id);
                    if (node) {
                        const offset = 30;
                        const newNode: NodeData = {
                            ...node,
                            id: `node-${Date.now()}`,
                            position: { x: node.position.x + offset, y: node.position.y + offset },
                            title: `${node.title} (Copy)`
                        };
                        dispatch({ type: 'ADD_NODE', payload: newNode });
                    }
                    setContextMenu(null); 
                }}
                onDisconnect={(id) => { dispatch({ type: 'DISCONNECT', payload: id }); setContextMenu(null); }}
                onClose={() => setContextMenu(null)} 
            />
        </>
      )}
    </div>
  );
}