import React, { useReducer, useState, useRef, useEffect } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { GraphState, Action, NodeData, NodeType, LogEntry } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition } from './utils/graphUtils';
import { Plus, Trash2 } from 'lucide-react';
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
    case 'CONNECT':
      if (state.connections.some(c => 
        c.sourceNodeId === action.payload.sourceNodeId && 
        c.targetNodeId === action.payload.targetNodeId && 
        c.targetPortId === action.payload.targetPortId 
      )) {
        return state;
      }
      // One connection per input port
      const filteredConnections = state.connections.filter(c => c.targetPortId !== action.payload.targetPortId);
      return { ...state, connections: [...filteredConnections, action.payload] };
    case 'DISCONNECT':
      return { ...state, connections: state.connections.filter(c => c.id !== action.payload) };
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
        return { ...initialState, ...action.payload, logs: {} }; // Don't load logs
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, targetNodeId?: string } | null>(null);
  const [tempWire, setTempWire] = useState<{ x1: number, y1: number, x2: number, y2: number, sourcePortId: string, sourceNodeId: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  // Load from LocalStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        dispatch({ type: 'LOAD_STATE', payload: parsed });
      } catch (e) {
        console.error('Failed to load state', e);
      }
    } else {
      // Default initial state
      dispatch({ type: 'ADD_NODE', payload: { ...NODE_DEFAULTS.HTML, id: 'node-1', type: 'HTML', position: { x: 100, y: 100 }, size: { width: 450, height: 350 } } as NodeData });
      dispatch({ type: 'ADD_NODE', payload: { ...NODE_DEFAULTS.PREVIEW, id: 'node-2', type: 'PREVIEW', position: { x: 650, y: 100 }, size: { width: 500, height: 400 } } as NodeData });
    }
    initialized.current = true;
  }, []);

  // Save to LocalStorage
  useEffect(() => {
    if (!initialized.current) return;
    const { nodes, connections, pan, zoom } = state;
    const toSave = { nodes, connections, pan, zoom };
    // Debounce slightly to avoid hammering disk
    const timer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.nodes, state.connections, state.pan, state.zoom]);

  // Listen for logs from iframes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && data.source === 'preview-iframe' && data.nodeId) {
        dispatch({
          type: 'ADD_LOG',
          payload: {
            nodeId: data.nodeId,
            log: { type: data.type, message: data.message, timestamp: data.timestamp }
          }
        });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, nodeId?: string) => {
    e.preventDefault();
    setContextMenu({ 
        x: e.clientX, 
        y: e.clientY,
        targetNodeId: nodeId
    });
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

  const handleDuplicateNode = (id: string) => {
      const node = state.nodes.find(n => n.id === id);
      if (!node) return;
      
      const newNode: NodeData = {
          ...node,
          id: `node-${Date.now()}`,
          position: { x: node.position.x + 20, y: node.position.y + 20 },
          title: `${node.title} (Copy)`
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
      downstreamConnections.forEach(c => {
         triggerUpdate(c.targetNodeId);
      });
    }
  };

  const handlePortDown = (e: React.PointerEvent, portId: string, isInput: boolean) => {
    if (isInput) return;
    
    const nodeEl = (e.target as HTMLElement).closest('[data-port-id]');
    const sourceNodeId = nodeEl?.getAttribute('data-port-id')?.split('-')[0] || '';
    
    const sourceNode = state.nodes.find(n => n.id === sourceNodeId);
    if (!sourceNode) return;
    
    const pos = calculatePortPosition(sourceNode, portId, 'output');
    
    setTempWire({
      x1: pos.x,
      y1: pos.y,
      x2: pos.x,
      y2: pos.y,
      sourcePortId: portId,
      sourceNodeId: sourceNodeId
    });
    
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const handleMouseMove = (e: React.PointerEvent) => {
    if (tempWire && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
      const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
      setTempWire({ ...tempWire, x2: x, y2: y });
    }
    
    if (e.buttons === 1 && !tempWire && (e.target as HTMLElement).id === 'canvas-bg') {
        dispatch({ type: 'PAN', payload: { x: state.pan.x + e.movementX, y: state.pan.y + e.movementY } });
    }
  };

  const handlePortUp = (e: React.PointerEvent, portId: string, isInput: boolean) => {
    if (!tempWire || !isInput) {
        setTempWire(null);
        return;
    }
    
    const targetNodeId = portId.split('-')[0];
    if (targetNodeId === tempWire.sourceNodeId) {
        setTempWire(null);
        return;
    }

    dispatch({
      type: 'CONNECT',
      payload: {
        id: `conn-${Date.now()}`,
        sourceNodeId: tempWire.sourceNodeId,
        sourcePortId: tempWire.sourcePortId,
        targetNodeId: targetNodeId,
        targetPortId: portId
      }
    });
    setTempWire(null);
  };

  const handleReset = () => {
    if(confirm('Clear all nodes and reset workspace?')) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.reload();
    }
  };
  
  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* UI Overlay */}
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex flex-col gap-2">
        <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">NodeCode Studio</h1>
            <p className="text-xs text-zinc-500">Right-click canvas to add. Right-click node to edit.</p>
        </div>
      </div>
      
      <div className="absolute top-4 right-4 z-50">
        <button 
            onClick={handleReset}
            className="px-3 py-1.5 bg-zinc-900/80 hover:bg-red-900/50 text-xs text-zinc-400 hover:text-red-400 border border-zinc-800 rounded transition-colors backdrop-blur flex items-center gap-2"
        >
            <Trash2 size={12} />
            Reset Workspace
        </button>
      </div>

      <div 
        ref={containerRef}
        id="canvas-bg"
        className="flex-1 relative cursor-grab active:cursor-grabbing"
        onContextMenu={(e) => handleContextMenu(e)}
        onPointerMove={handleMouseMove}
        onPointerUp={() => setTempWire(null)}
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
                {/* Wires */}
                <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                    {state.connections.map(conn => {
                        const sourceNode = state.nodes.find(n => n.id === conn.sourceNodeId);
                        const targetNode = state.nodes.find(n => n.id === conn.targetNodeId);
                        if (!sourceNode || !targetNode) return null;

                        const start = calculatePortPosition(sourceNode, conn.sourcePortId, 'output');
                        const end = calculatePortPosition(targetNode, conn.targetPortId, 'input');
                        
                        return (
                            <Wire key={conn.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
                        );
                    })}
                    {tempWire && (
                        <Wire x1={tempWire.x1} y1={tempWire.y1} x2={tempWire.x2} y2={tempWire.y2} active />
                    )}
                </svg>

                {/* Nodes */}
                {state.nodes.map(node => {
                    let logs: LogEntry[] = [];
                    if (node.type === 'TERMINAL') {
                         const sources = state.connections
                            .filter(c => c.targetNodeId === node.id)
                            .map(c => c.sourceNodeId);
                         logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                    }

                    return (
                        <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                            <Node
                                data={node}
                                isSelected={false}
                                scale={state.zoom}
                                onMove={(id, pos) => dispatch({ type: 'UPDATE_NODE_POSITION', payload: { id, position: pos } })}
                                onResize={(id, size) => dispatch({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                onDelete={(id) => dispatch({ type: 'DELETE_NODE', payload: id })}
                                onRun={handleRun}
                                onPortDown={handlePortDown}
                                onPortUp={handlePortUp}
                                logs={logs}
                            >
                                {(node.type === 'HTML' || node.type === 'CSS' || node.type === 'JS') && (
                                    <div className="w-full h-full bg-[#0f0f11] overflow-auto custom-scrollbar nodrag">
                                        <Editor
                                            value={node.content}
                                            onValueChange={code => dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: node.id, content: code } })}
                                            highlight={code => Prism.highlight(
                                                code, 
                                                node.type === 'HTML' ? Prism.languages.markup : 
                                                node.type === 'CSS' ? Prism.languages.css : Prism.languages.javascript, 
                                                node.type === 'HTML' ? 'markup' : node.type.toLowerCase()
                                            )}
                                            padding={12}
                                            style={{
                                                fontFamily: '"JetBrains Mono", monospace',
                                                fontSize: 13,
                                                minHeight: '100%',
                                            }}
                                            className="min-h-full"
                                            textareaClassName="focus:outline-none"
                                        />
                                    </div>
                                )}
                            </Node>
                        </div>
                    );
                })}
            </div>
        </div>
      </div>

      <div className="absolute bottom-6 right-6">
        <button 
            onClick={() => setContextMenu({ x: window.innerWidth / 2, y: window.innerHeight / 2 })}
            className="w-12 h-12 bg-accent hover:bg-blue-600 rounded-full flex items-center justify-center shadow-lg text-white transition-transform hover:scale-105"
        >
            <Plus size={24} />
        </button>
      </div>

      {contextMenu && (
        <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
            <ContextMenu 
                position={contextMenu} 
                targetNodeId={contextMenu.targetNodeId}
                onAdd={handleAddNode} 
                onDeleteNode={(id) => { dispatch({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); }}
                onDuplicateNode={handleDuplicateNode}
                onClose={() => setContextMenu(null)} 
            />
        </>
      )}
    </div>
  );
}