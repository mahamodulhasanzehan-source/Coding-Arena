import React, { useReducer, useState, useRef, useEffect, useMemo } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { NodeData, NodeType, LogEntry, UserPresence } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, UploadCloud, Plus, Minus, Search, Download } from 'lucide-react';
import { signIn, db } from './firebase';
import { doc, setDoc, onSnapshot, collection, deleteDoc } from 'firebase/firestore';
import JSZip from 'jszip';
import { loader } from '@monaco-editor/react';
import { graphReducer, initialState } from './store/graphReducer';
import { useGraphAI } from './hooks/useGraphAI';

loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.46.0/min/vs',
  },
});

type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

const getRandomColor = () => {
  const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'];
  return colors[Math.floor(Math.random() * colors.length)];
};

export default function App() {
    const [state, dispatch] = useReducer(graphReducer, initialState);
    
    // UI Local State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, targetNodeId?: string, targetPortId?: string, targetNode?: NodeData } | null>(null);
    const [isPanning, setIsPanning] = useState(false);
    const [dragWire, setDragWire] = useState<{ x1: number, y1: number, x2: number, y2: number, startPortId: string, startNodeId: string, isInput: boolean } | null>(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
    const [userUid, setUserUid] = useState<string | null>(null);
    const [userColor] = useState(getRandomColor());

    const sessionId = useMemo(() => `session-${Math.random().toString(36).substr(2, 9)}`, []);
    const isLocalChange = useRef(false);
    const lastTouchDist = useRef<number | null>(null);
    const isPinching = useRef(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const throttleRef = useRef(0);

    const dispatchLocal = (action: any) => {
        if ([
            'ADD_NODE', 'DELETE_NODE', 'UPDATE_NODE_POSITION', 'UPDATE_NODE_SIZE',
            'UPDATE_NODE_CONTENT', 'UPDATE_NODE_TITLE', 'UPDATE_NODE_TYPE',
            'CONNECT', 'DISCONNECT', 'TOGGLE_PREVIEW', 'SET_NODE_LOADING',
            'UPDATE_NODE_SHARED_STATE', 'TOGGLE_MINIMIZE'
        ].includes(action.type)) {
            isLocalChange.current = true;
        }
        dispatch(action);
    };

    // --- AI HOOK ---
    const { handleSendMessage, handleAiGenerate, handleInjectImport, handleFixError } = useGraphAI(state, dispatch, dispatchLocal);

    // --- FIREBASE INIT ---
    useEffect(() => {
        const init = async () => {
            try {
                setSyncStatus('saving');
                const user = await signIn();
                setUserUid(user.uid);
                
                const docRef = doc(db, 'nodecode_projects', 'global_project_room');
                
                onSnapshot(docRef, (docSnap) => {
                    if (docSnap.metadata.hasPendingWrites) return;
                    if (docSnap.exists()) {
                        const data = docSnap.data() as { state: string };
                        if (data && data.state) {
                            const loadedState = JSON.parse(data.state);
                            dispatch({ type: 'LOAD_STATE', payload: loadedState });
                        }
                    } else {
                        // Defaults
                        const codeDefaults = NODE_DEFAULTS.CODE;
                        const previewDefaults = NODE_DEFAULTS.PREVIEW;
                        const defaultNodes: NodeData[] = [
                            { id: 'node-1', type: 'CODE', position: { x: 100, y: 100 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'index.html', content: '<h1>Hello World</h1>\n<link href="style.css" rel="stylesheet">\n<script src="app.js"></script>', autoHeight: false },
                            { id: 'node-2', type: 'CODE', position: { x: 100, y: 450 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'style.css', content: 'body { background: #222; color: #fff; font-family: sans-serif; }', autoHeight: false },
                            { id: 'node-3', type: 'PREVIEW', position: { x: 600, y: 100 }, size: { width: previewDefaults.width, height: previewDefaults.height }, title: previewDefaults.title, content: previewDefaults.content }
                        ];
                        const defaultState = { nodes: defaultNodes, connections: [], pan: { x: 0, y: 0 }, zoom: 1 };
                        setDoc(docRef, { state: JSON.stringify(defaultState), updatedAt: new Date().toISOString() });
                        dispatch({ type: 'LOAD_STATE', payload: defaultState });
                    }
                    setSyncStatus('synced');
                });

                // Presence
                const presenceRef = collection(db, 'nodecode_projects', 'global_project_room', 'presence');
                onSnapshot(presenceRef, (snapshot) => {
                    const activeUsers: UserPresence[] = [];
                    const now = Date.now();
                    snapshot.forEach(doc => {
                        const data = doc.data() as UserPresence;
                        if (data.id !== sessionId && (now - data.lastActive < 30000)) activeUsers.push(data);
                    });
                    dispatch({ type: 'UPDATE_COLLABORATORS', payload: activeUsers });
                });

                const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
                await setDoc(myPresenceRef, { id: sessionId, x: 0, y: 0, color: userColor, lastActive: Date.now() });

            } catch (e) {
                console.error(e);
                setSyncStatus('error');
            }
        };
        init();
        return () => { deleteDoc(doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId)).catch(() => {}); }
    }, [sessionId, userColor]);

    // --- SYNC LOOP ---
    useEffect(() => {
        const interval = setInterval(() => {
            if (userUid) {
                 const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
                 setDoc(myPresenceRef, { lastActive: Date.now() }, { merge: true }).catch(() => {});
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [userUid, sessionId]);

    useEffect(() => {
        if (!userUid) return;
        if (isLocalChange.current) {
            setSyncStatus('saving');
            const saveData = setTimeout(async () => {
                try {
                    const docRef = doc(db, 'nodecode_projects', 'global_project_room');
                    const stateToSave = {
                        nodes: state.nodes.map(n => ({...n, isLoading: false})),
                        connections: state.connections,
                        runningPreviewIds: state.runningPreviewIds,
                        pan: { x: 0, y: 0 }, zoom: 1 
                    };
                    await setDoc(docRef, { state: JSON.stringify(stateToSave), updatedAt: new Date().toISOString() }, { merge: true });
                    setSyncStatus('synced');
                    isLocalChange.current = false;
                } catch (e) {
                    setSyncStatus('error');
                }
            }, 800);
            return () => clearTimeout(saveData);
        }
    }, [state.nodes, state.connections, state.runningPreviewIds, userUid]);

    // --- PREVIEW & MESSAGES ---
    useEffect(() => {
        state.runningPreviewIds.forEach(previewId => {
            const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
            if (iframe) {
                const compiled = compilePreview(previewId, state.nodes, state.connections, false);
                if (iframe.srcdoc !== compiled) iframe.srcdoc = compiled;
            }
        });
    }, [state.nodes, state.connections, state.runningPreviewIds]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const data = event.data;
            if (!data) return;
            if (data.source === 'preview-iframe' && data.nodeId) {
                if (data.type === 'log' || data.type === 'error' || data.type === 'warn' || data.type === 'info') {
                    dispatch({ type: 'ADD_LOG', payload: { nodeId: data.nodeId, log: { type: data.type, message: data.message, timestamp: data.timestamp } } });
                }
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [state.nodes]);

    // --- INTERACTION HANDLERS ---
    const handleUpdateTitle = (id: string, newTitle: string) => {
        dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title: newTitle } });
    };

    const handleContextMenu = (e: React.MouseEvent, nodeId?: string) => {
        e.preventDefault();
        const node = nodeId ? state.nodes.find(n => n.id === nodeId) : undefined;
        setContextMenu({ x: e.clientX, y: e.clientY, targetNodeId: nodeId, targetNode: node });
    };

    const handlePortContextMenu = (e: React.MouseEvent, portId: string) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId)) {
            setContextMenu({ x: e.clientX, y: e.clientY, targetPortId: portId });
        }
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
            autoHeight: type === 'CODE' ? false : undefined,
        };
        dispatchLocal({ type: 'ADD_NODE', payload: newNode });
        setContextMenu(null);
    };

    const handleHighlightNode = (id: string) => {
        setHighlightedNodeId(id);
        setTimeout(() => setHighlightedNodeId(null), 2000);
    };

    const handleToggleRun = (id: string) => {
        const isRunning = state.runningPreviewIds.includes(id);
        const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
        if (!isRunning) {
            dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: true } });
            dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
        } else {
            dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: false } });
            dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
            if (iframe) iframe.srcdoc = '<body style="background-color: #000; color: #555; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; font-family: sans-serif;">STOPPED</body>';
        }
    };

    const handleRefresh = (id: string) => {
        const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
        if (iframe) iframe.srcdoc = compilePreview(id, state.nodes, state.connections, true);
    };

    const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
        e.stopPropagation();
        e.preventDefault();
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const pos = calculatePortPosition(node, portId, isInput ? 'input' : 'output');
        setDragWire({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, startPortId: portId, startNodeId: nodeId, isInput });
        e.currentTarget.setPointerCapture(e.pointerId);
    };

    const handleBgPointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        if (isPinching.current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setIsPanning(true);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const now = Date.now();
        if (now - throttleRef.current > 50 && containerRef.current && userUid) {
            throttleRef.current = now;
            const rect = containerRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const worldX = (mouseX - state.pan.x) / state.zoom;
            const worldY = (mouseY - state.pan.y) / state.zoom;
            const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
            setDoc(myPresenceRef, { x: worldX, y: worldY, lastActive: now, color: userColor }, { merge: true }).catch(() => {});
        }

        if (isPinching.current) return;

        if (dragWire && containerRef.current) {
            const x = (e.clientX - containerRef.current.getBoundingClientRect().left - state.pan.x) / state.zoom;
            const y = (e.clientY - containerRef.current.getBoundingClientRect().top - state.pan.y) / state.zoom;
            setDragWire(prev => prev ? { ...prev, x2: x, y2: y } : null);
        }

        if (isPanning) {
            dispatch({ type: 'PAN', payload: { x: state.pan.x + e.movementX, y: state.pan.y + e.movementY } });
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (isPanning) {
            setIsPanning(false);
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        }
        if (dragWire) {
            const targetEl = document.elementFromPoint(e.clientX, e.clientY);
            const portEl = targetEl?.closest('[data-port-id]');
            if (portEl) {
                const endPortId = portEl.getAttribute('data-port-id');
                const endNodeId = portEl.getAttribute('data-node-id');
                if (endPortId && endNodeId && endPortId !== dragWire.startPortId) {
                    const isStartInput = dragWire.isInput;
                    const isTargetInput = endPortId.includes('-in-');
                    if (isStartInput !== isTargetInput && dragWire.startNodeId !== endNodeId) {
                        dispatchLocal({
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
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        if ((e.target as HTMLElement).closest('.custom-scrollbar') || (e.target as HTMLElement).closest('.monaco-editor')) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - state.pan.x) / state.zoom;
        const worldY = (mouseY - state.pan.y) / state.zoom;
        const newZoom = Math.min(Math.max(0.1, state.zoom - e.deltaY * 0.001), 3);
        const newPanX = mouseX - worldX * newZoom;
        const newPanY = mouseY - worldY * newZoom;
        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    };

    const handleDownloadZip = async () => {
        const zip = new JSZip();
        const codeNodes = state.nodes.filter(n => n.type === 'CODE');
        if (codeNodes.length === 0) return alert("No code modules to download.");
        codeNodes.forEach(n => zip.file(n.title, n.content));
        const content = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url;
        a.download = "project.zip";
        a.click();
        window.URL.revokeObjectURL(url);
    };

    const handleReset = async () => {
        if (prompt("Enter password to reset:") === 'password') {
            localStorage.removeItem('nodecode-studio-v1');
            if (userUid) await deleteDoc(doc(db, 'nodecode_projects', 'global_project_room'));
            window.location.reload();
        }
    };

    const handleCancelAi = (nodeId: string) => {
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
    };

    const handleClearImage = (nodeId: string) => {
         dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: '' } });
         setContextMenu(null);
    };

    const displayNodes = useMemo(() => {
        return state.nodes.map(node => {
            const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId);
            return collaborator && collaborator.draggingPosition ? { ...node, position: collaborator.draggingPosition } : node;
        });
    }, [state.nodes, state.collaborators, sessionId]);

    return (
        <div className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none" onContextMenu={(e) => e.preventDefault()}>
            <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">Coding Arena</h1>
                    <p className="text-xs text-zinc-500">Global Collaborative Session</p>
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/80 border border-zinc-800 rounded-full backdrop-blur-sm pointer-events-auto">
                    {syncStatus === 'synced' && <Cloud size={14} className="text-emerald-500" />}
                    {syncStatus === 'saving' && <UploadCloud size={14} className="text-amber-500 animate-pulse" />}
                    {syncStatus === 'offline' && <CloudOff size={14} className="text-zinc-500" />}
                    <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400">
                        {syncStatus === 'synced' ? 'Saved' : syncStatus === 'saving' ? 'Saving...' : 'Offline'}
                    </span>
                </div>
            </div>

            <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 items-end">
                <button onClick={handleReset} className="hidden md:flex px-3 py-1.5 bg-zinc-900/80 hover:bg-red-900/50 text-xs text-zinc-400 border border-zinc-800 rounded items-center gap-2 pointer-events-auto cursor-pointer">
                    <Trash2 size={12} /> Reset
                </button>
                <button onClick={() => setIsSidebarOpen(true)} className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-400 border border-zinc-800 rounded pointer-events-auto cursor-pointer">
                    <Menu size={16} />
                </button>
                <div className="flex flex-col gap-1 mt-2">
                    <button onClick={() => { const vp = { w: window.innerWidth, h: window.innerHeight }; const cx = (vp.w/2-state.pan.x)/state.zoom; const cy = (vp.h/2-state.pan.y)/state.zoom; dispatch({ type: 'ZOOM', payload: { zoom: Math.min(state.zoom + 0.1, 3) } }); dispatch({ type: 'PAN', payload: { x: vp.w/2 - cx*(state.zoom+0.1), y: vp.h/2 - cy*(state.zoom+0.1) } }); }} className="md:hidden px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded pointer-events-auto"><Plus size={16} /></button>
                    <button onClick={() => { const vp = { w: window.innerWidth, h: window.innerHeight }; const cx = (vp.w/2-state.pan.x)/state.zoom; const cy = (vp.h/2-state.pan.y)/state.zoom; dispatch({ type: 'ZOOM', payload: { zoom: Math.max(state.zoom - 0.1, 0.1) } }); dispatch({ type: 'PAN', payload: { x: vp.w/2 - cx*(state.zoom-0.1), y: vp.h/2 - cy*(state.zoom-0.1) } }); }} className="md:hidden px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded pointer-events-auto"><Minus size={16} /></button>
                    <button onClick={handleDownloadZip} className="hidden md:flex px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded items-center justify-center pointer-events-auto" title="Download"><Download size={16} /></button>
                </div>
            </div>

            <Sidebar isOpen={isSidebarOpen} nodes={state.nodes} onNodeClick={handleHighlightNode} onClose={() => setIsSidebarOpen(false)} selectionMode={state.selectionMode?.isActive ? { isActive: true, selectedIds: state.selectionMode.selectedIds, onToggle: (id) => dispatch({ type: 'SET_SELECTION_MODE', payload: { ...state.selectionMode!, selectedIds: state.selectionMode!.selectedIds.includes(id) ? state.selectionMode!.selectedIds.filter(i => i !== id) : [...state.selectionMode!.selectedIds, id] } }), onConfirm: () => { dispatch({ type: 'UPDATE_CONTEXT_NODES', payload: { id: state.selectionMode!.requestingNodeId, nodeIds: state.selectionMode!.selectedIds } }); dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: false } }); } } : undefined} />

            <div ref={containerRef} id="canvas-bg" className="flex-1 relative cursor-grab active:cursor-grabbing" onContextMenu={handleContextMenu} onPointerDown={handleBgPointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onWheel={handleWheel} style={{ backgroundImage: 'radial-gradient(#3f3f46 2px, transparent 2px)', backgroundSize: `${Math.max(20 * state.zoom, 10)}px ${Math.max(20 * state.zoom, 10)}px`, backgroundPosition: `${state.pan.x}px ${state.pan.y}px`, touchAction: 'none' }}>
                <div style={{ transform: `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`, transformOrigin: '0 0', width: '100%', height: '100%', pointerEvents: 'none' }}>
                    <div className="pointer-events-none w-full h-full relative">
                        {state.collaborators.map(user => (<CollaboratorCursor key={user.id} x={user.x} y={user.y} color={user.color} name={''} />))}
                        <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                            {state.connections.map(conn => {
                                const s = displayNodes.find(n => n.id === conn.sourceNodeId);
                                const t = displayNodes.find(n => n.id === conn.targetNodeId);
                                if (!s || !t) return null;
                                const start = calculatePortPosition(s, conn.sourcePortId, 'output');
                                const end = calculatePortPosition(t, conn.targetPortId, 'input');
                                return <Wire key={conn.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
                            })}
                        </svg>
                        {displayNodes.map(node => {
                            let logs: LogEntry[] = [];
                            if (node.type === 'TERMINAL') {
                                const sources = state.connections.filter(c => c.targetNodeId === node.id).map(c => c.sourceNodeId);
                                logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                            }
                            const collab = state.collaborators.find(c => (c.draggingNodeId === node.id || c.editingNodeId === node.id) && c.id !== sessionId);
                            const collabInfo = collab ? { name: '', color: collab.color, action: (collab.editingNodeId === node.id ? 'editing' : 'dragging') as any } : undefined;
                            return (
                                <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                                    <Node
                                        data={node}
                                        isSelected={false}
                                        isHighlighted={node.id === highlightedNodeId}
                                        isRunning={state.runningPreviewIds.includes(node.id)}
                                        scale={state.zoom}
                                        isConnected={(pid) => state.connections.some(c => c.sourcePortId === pid || c.targetPortId === pid)}
                                        onMove={(id, pos) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: pos } })}
                                        onResize={(id, size) => dispatchLocal({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                        onDelete={(id) => dispatchLocal({ type: 'DELETE_NODE', payload: id })}
                                        onToggleRun={handleToggleRun}
                                        onRefresh={handleRefresh}
                                        onPortDown={handlePortDown}
                                        onPortContextMenu={handlePortContextMenu}
                                        onUpdateTitle={handleUpdateTitle}
                                        onUpdateContent={(id, content) => dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content } })}
                                        onSendMessage={handleSendMessage}
                                        onStartContextSelection={(id) => { dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: true, requestingNodeId: id, selectedIds: state.nodes.find(n=>n.id===id)?.contextNodeIds || [] } }); setIsSidebarOpen(true); }}
                                        onAiAction={handleAiGenerate}
                                        onCancelAi={handleCancelAi}
                                        onInjectImport={handleInjectImport}
                                        onFixError={handleFixError}
                                        onInteraction={(id, type) => dispatch({ type: 'SET_NODE_INTERACTION', payload: { nodeId: id, type } })}
                                        onToggleMinimize={(id) => dispatchLocal({ type: 'TOGGLE_MINIMIZE', payload: id })}
                                        collaboratorInfo={collabInfo}
                                        logs={logs}
                                    />
                                </div>
                            );
                        })}
                        {dragWire && (<svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none" style={{ zIndex: 999 }}><Wire x1={dragWire.x1} y1={dragWire.y1} x2={dragWire.x2} y2={dragWire.y2} active /></svg>)}
                    </div>
                </div>
            </div>
            {contextMenu && (
                <>
                    <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
                    <ContextMenu
                        position={contextMenu}
                        targetNodeId={contextMenu.targetNodeId}
                        targetNode={contextMenu.targetNode}
                        targetPortId={contextMenu.targetPortId}
                        onAdd={handleAddNode}
                        onDeleteNode={(id) => { dispatchLocal({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); }}
                        onDuplicateNode={(id) => { const n = state.nodes.find(no => no.id === id); if (n) dispatchLocal({ type: 'ADD_NODE', payload: { ...n, id: `node-${Date.now()}`, position: { x: n.position.x + 30, y: n.position.y + 30 }, title: `${n.title} (Copy)` } }); setContextMenu(null); }}
                        onDisconnect={(id) => { dispatchLocal({ type: 'DISCONNECT', payload: id }); setContextMenu(null); }}
                        onClearImage={handleClearImage}
                        onClose={() => setContextMenu(null)}
                    />
                </>
            )}
        </div>
    );
}