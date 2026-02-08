
import React, { useReducer, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { GraphState, Action, NodeData, NodeType, LogEntry, Position } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition, getConnectedSource } from './utils/graphUtils';
import { Menu, Cloud, CloudOff, UploadCloud, Download, Search, AlertTriangle } from 'lucide-react';
import { auth, onAuthStateChanged, db, doc, getDoc, setDoc, deleteDoc } from './firebase';
import JSZip from 'jszip';
import { handleAiMessage, handleAiGeneration } from './aiManager';

// Helper to avoid TS errors with process.env if @types/node is missing
declare const process: any;

const initialState: GraphState = {
  nodes: [],
  connections: [],
  pan: { x: 0, y: 0 },
  zoom: 1,
  logs: {},
  runningPreviewIds: [],
  selectionMode: { isActive: false, requestingNodeId: '', selectedIds: [] },
  collaborators: [],
  nodeInteractions: {},
  selectedNodeIds: [],
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
        logs: { ...state.logs, [action.payload]: [] },
        runningPreviewIds: state.runningPreviewIds.filter(id => id !== action.payload),
        selectedNodeIds: state.selectedNodeIds.filter(id => id !== action.payload)
      };
    case 'UPDATE_NODE_POSITION':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, position: action.payload.position } : n)
      };
    case 'UPDATE_NODE_SIZE':
      return {
        ...state,
        nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, size: action.payload.size, autoHeight: false } : n)
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
    case 'UPDATE_NODE_TYPE':
        return {
            ...state,
            nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, type: action.payload.type } : n)
        };
    case 'ADD_MESSAGE':
       return {
           ...state,
           nodes: state.nodes.map(n => n.id === action.payload.id ? {
               ...n,
               messages: [...(n.messages || []), action.payload.message]
           } : n)
       };
    case 'UPDATE_LAST_MESSAGE':
        return {
            ...state,
            nodes: state.nodes.map(n => {
                if (n.id !== action.payload.id) return n;
                const msgs = n.messages || [];
                if (msgs.length === 0) return n;
                const newMsgs = [...msgs];
                newMsgs[newMsgs.length - 1] = { ...newMsgs[newMsgs.length - 1], text: action.payload.text };
                return { ...n, messages: newMsgs };
            })
        };
    case 'SET_NODE_LOADING':
        return {
            ...state,
            nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, isLoading: action.payload.isLoading } : n)
        };
    case 'UPDATE_CONTEXT_NODES':
        return {
            ...state,
            nodes: state.nodes.map(n => n.id === action.payload.id ? {
                ...n,
                contextNodeIds: action.payload.nodeIds
            } : n)
        };
    case 'SET_SELECTION_MODE':
        return {
            ...state,
            selectionMode: {
                isActive: action.payload.isActive,
                requestingNodeId: action.payload.requestingNodeId || '',
                selectedIds: action.payload.selectedIds || []
            }
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
          connections: state.connections.filter(c => 
              c.id !== action.payload && 
              c.sourcePortId !== action.payload && 
              c.targetPortId !== action.payload
          ) 
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
    case 'TOGGLE_PREVIEW':
        const { nodeId, isRunning } = action.payload;
        return {
            ...state,
            runningPreviewIds: isRunning 
                ? [...state.runningPreviewIds, nodeId] 
                : state.runningPreviewIds.filter(id => id !== nodeId)
        };
    case 'LOAD_STATE':
        if (!action.payload) return state;
        return { 
          ...state, 
          nodes: action.payload.nodes || [], 
          connections: action.payload.connections || state.connections,
          runningPreviewIds: action.payload.runningPreviewIds || state.runningPreviewIds,
          pan: action.payload.pan || state.pan,
          zoom: action.payload.zoom || state.zoom
        };
    case 'UPDATE_COLLABORATORS':
        return { ...state, collaborators: action.payload };
    case 'SET_NODE_INTERACTION':
        return {
            ...state,
            nodeInteractions: {
                ...state.nodeInteractions,
                [action.payload.nodeId]: action.payload.type
            }
        };
    case 'UPDATE_NODE_SHARED_STATE':
        return {
            ...state,
            nodes: state.nodes.map(n => n.id === action.payload.nodeId ? { ...n, sharedState: action.payload.state } : n)
        };
    case 'TOGGLE_MINIMIZE':
        return {
            ...state,
            nodes: state.nodes.map(n => {
                if (n.id !== action.payload.id) return n;
                const shouldMinimize = !n.isMinimized;
                if (shouldMinimize) {
                     return { ...n, isMinimized: true, expandedSize: n.size, size: { width: n.size.width, height: 40 } };
                } else {
                     const restoredSize = n.expandedSize || NODE_DEFAULTS[n.type];
                     return { ...n, isMinimized: false, expandedSize: undefined, size: restoredSize };
                }
            })
        };
    case 'SET_SELECTED_NODES':
        return { ...state, selectedNodeIds: action.payload };
    case 'LOCK_NODES':
        return {
            ...state,
            nodes: state.nodes.map(n => 
                action.payload.ids.includes(n.id) 
                ? { ...n, lockedBy: action.payload.user } 
                : n
            )
        };
    default:
      return state;
  }
}

type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
  const stateRef = useRef(state); 
  stateRef.current = state; 

  const [contextMenu, setContextMenu] = useState<{ 
      x: number; 
      y: number; 
      targetNodeId?: string; 
      targetPortId?: string; 
      targetNode?: NodeData;
      canAlignHorizontal?: boolean;
      canAlignVertical?: boolean;
      canDistributeHorizontal?: boolean;
      canDistributeVertical?: boolean;
      canCompactHorizontal?: boolean;
      canCompactVertical?: boolean;
  } | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [dragWire, setDragWire] = useState<{ x1: number, y1: number, x2: number, y2: number, startPortId: string, startNodeId: string, isInput: boolean } | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [currentUser, setCurrentUser] = useState<{ uid: string; displayName: string } | null>(null);
  const [snapLines, setSnapLines] = useState<{x1: number, y1: number, x2: number, y2: number}[]>([]);
  const [maximizedNodeId, setMaximizedNodeId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number, y: number, w: number, h: number, startX: number, startY: number } | null>(null);

  const sessionId = useMemo(() => `session-${Math.random().toString(36).substr(2, 9)}`, []);
  const isLocalChange = useRef(false);
  const lastTouchDist = useRef<number | null>(null);
  const isPinching = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number, y: number } | null>(null);
  const touchStartPos = useRef<{ x: number, y: number } | null>(null);
  const compileTimeoutRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const lastContentHash = useRef<string>('');

  // --- MANUAL EVENT LISTENER ATTACHMENT TO FIX PASSIVE LISTENER ERROR ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
        // Prevent default browser zoom
        e.preventDefault();

        // Use state from Ref to avoid stale closure or re-binding
        const currentState = stateRef.current;
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const zoomFactor = -e.deltaY * 0.001;
        const newZoom = Math.min(Math.max(0.1, currentState.zoom + zoomFactor), 5);
        
        const dx = (mouseX - currentState.pan.x) / currentState.zoom;
        const dy = (mouseY - currentState.pan.y) / currentState.zoom;
        
        const newPanX = mouseX - dx * newZoom;
        const newPanY = mouseY - dy * newZoom;

        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    };

    const onTouchStart = (e: TouchEvent) => {
        if (e.touches.length === 2) {
             e.preventDefault(); // Stop browser gesture
             // Logic handled in React's onTouchStart but preventDefault needed here for some browsers
        }
    };

    const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length === 2) {
             e.preventDefault(); // Stop browser gesture
        }
    };

    // Attach with passive: false to allow preventDefault
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
    };
  }, []); // Empty dependency array ensures we only attach once

  // --- TERMINAL LOG LISTENER ---
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.source === 'preview-iframe') {
        const { nodeId, type, message, timestamp } = e.data;
        dispatch({
          type: 'ADD_LOG',
          payload: {
            nodeId,
            log: { type, message, timestamp }
          }
        });
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
              if (maximizedNodeId) {
                  setMaximizedNodeId(null);
              } else if (state.selectedNodeIds.length > 0) {
                  dispatch({ type: 'SET_SELECTED_NODES', payload: [] });
              }
          }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, [maximizedNodeId, state.selectedNodeIds]);

  useEffect(() => {
      const unsubscribe = onAuthStateChanged(auth, async (user) => {
          if (user) {
              const userInfo = { uid: user.uid, displayName: user.displayName || user.email || 'Anonymous' };
              setCurrentUser(userInfo);
              setSyncStatus('saving'); 
              try {
                  const docRef = doc(db, "nodecode_projects", user.uid);
                  const docSnap = await getDoc(docRef);
                  if (docSnap.exists() && docSnap.data().state) {
                      try {
                          dispatch({ type: 'LOAD_STATE', payload: JSON.parse(docSnap.data().state) });
                          setSyncStatus('synced');
                      } catch (e) { console.error(e); setSyncStatus('error'); }
                  } else { loadLocalOrDefaults(); setSyncStatus('synced'); }
              } catch (err) { console.error(err); setSyncStatus('error'); }
          } else { setCurrentUser(null); setSyncStatus('offline'); loadLocalOrDefaults(); }
      });
      return () => unsubscribe();
  }, []);

  const loadLocalOrDefaults = () => {
      const local = localStorage.getItem('nodecode_project_local');
      if (local) {
          try { dispatch({ type: 'LOAD_STATE', payload: JSON.parse(local) }); } catch(e) {}
      } else {
          const codeDefaults = NODE_DEFAULTS.CODE;
          const previewDefaults = NODE_DEFAULTS.PREVIEW;
          const defaultNodes: NodeData[] = [
              { id: 'node-1', type: 'CODE', position: { x: 100, y: 100 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'index.html', content: '<h1>Hello World</h1>\n<link href="style.css" rel="stylesheet">\n<script src="app.js"></script>', autoHeight: true },
              { id: 'node-2', type: 'CODE', position: { x: 100, y: 450 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'style.css', content: 'body { background: #222; color: #fff; font-family: sans-serif; }', autoHeight: true },
              { id: 'node-3', type: 'PREVIEW', position: { x: 600, y: 100 }, size: { width: previewDefaults.width, height: previewDefaults.height }, title: previewDefaults.title, content: previewDefaults.content }
          ];
          dispatch({ type: 'LOAD_STATE', payload: { nodes: defaultNodes, connections: [], pan: {x:0, y:0}, zoom: 1 } });
      }
  };

  // --- Live Preview Re-compilation ---
  useEffect(() => {
      // 1. Calculate a signature for the current content state
      // This includes ONLY fields that affect the generated code.
      // We exclude 'size', 'position', 'isMinimized', etc.
      const currentContentHash = JSON.stringify({
          nodes: state.nodes.map(n => ({ 
              id: n.id, 
              title: n.title, 
              content: n.content, 
              type: n.type 
          })),
          connections: state.connections,
          running: state.runningPreviewIds
      });

      // 2. Compare with previous signature
      // If content hasn't changed, we SKIP the compilation step entirely.
      // This prevents UI interactions (like minimize/expand) from triggering a preview reload/flash.
      if (currentContentHash === lastContentHash.current) {
          return;
      }
      lastContentHash.current = currentContentHash;

      state.runningPreviewIds.forEach(previewId => {
          if (compileTimeoutRef.current[previewId]) clearTimeout(compileTimeoutRef.current[previewId]);
          
          compileTimeoutRef.current[previewId] = setTimeout(() => {
              const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
              if (iframe) {
                  const compiled = compilePreview(previewId, state.nodes, state.connections);
                  if (iframe.srcdoc !== compiled) {
                      iframe.srcdoc = compiled;
                  }
              }
          }, 500); 
      });
  }, [state.nodes, state.connections, state.runningPreviewIds]);

  const hiddenNodeIds = useMemo(() => {
      const ids = new Set<string>();
      const getChildren = (folderId: string) => {
           return state.connections
              .filter(c => c.targetNodeId === folderId && c.targetPortId.includes('in-files'))
              .map(c => c.sourceNodeId);
      };
      const traverse = (parentId: string) => {
          const children = getChildren(parentId);
          children.forEach(childId => {
              if (!ids.has(childId)) {
                  ids.add(childId);
                  const childNode = state.nodes.find(n => n.id === childId);
                  if (childNode && childNode.type === 'FOLDER') {
                      traverse(childId);
                  }
              }
          });
      };
      state.nodes.forEach(node => {
          if (node.type === 'FOLDER' && node.isMinimized) {
              traverse(node.id);
          }
      });
      return ids;
  }, [state.nodes, state.connections]);

  const displayNodes = useMemo(() => {
    return state.nodes
        .filter(n => !hiddenNodeIds.has(n.id)) 
        .map(node => {
            const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId);
            if (collaborator && collaborator.draggingPosition) {
                return { ...node, position: collaborator.draggingPosition, _remoteDrag: true };
            }
            return node;
        });
  }, [state.nodes, state.collaborators, sessionId, hiddenNodeIds]);

  const regularNodes = useMemo(() => displayNodes.filter(n => n.id !== maximizedNodeId), [displayNodes, maximizedNodeId]);
  const maximizedNode = useMemo(() => displayNodes.find(n => n.id === maximizedNodeId), [displayNodes, maximizedNodeId]);

  const dispatchLocal = (action: Action) => {
      if (['ADD_NODE', 'DELETE_NODE', 'UPDATE_NODE_POSITION', 'UPDATE_NODE_SIZE', 'UPDATE_NODE_CONTENT', 'UPDATE_NODE_TITLE', 'UPDATE_NODE_TYPE', 'CONNECT', 'DISCONNECT', 'TOGGLE_PREVIEW', 'SET_NODE_LOADING', 'UPDATE_NODE_SHARED_STATE', 'TOGGLE_MINIMIZE', 'SET_SELECTED_NODES', 'LOCK_NODES'].includes(action.type)) {
          isLocalChange.current = true;
      }
      dispatch(action);
  };

  useEffect(() => {
    if (isLocalChange.current) {
        setSyncStatus('saving');
        const saveData = setTimeout(async () => {
             const stateToSave = { nodes: state.nodes, connections: state.connections, runningPreviewIds: state.runningPreviewIds, pan: state.pan, zoom: state.zoom };
             localStorage.setItem('nodecode_project_local', JSON.stringify(stateToSave));
             if (currentUser) {
                 try {
                     await setDoc(doc(db, "nodecode_projects", currentUser.uid), { state: JSON.stringify(stateToSave), updatedAt: new Date().toISOString() }, { merge: true });
                     setSyncStatus('synced');
                 } catch (e) { console.error(e); setSyncStatus('error'); }
             } else { setSyncStatus('offline'); }
             isLocalChange.current = false; 
        }, 1000);
        return () => clearTimeout(saveData);
    }
  }, [state.nodes, state.connections, state.runningPreviewIds, state.pan, state.zoom, currentUser]); 

  // --- Handlers ---
  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent | React.PointerEvent, nodeId?: string, portId?: string) => {
    e.preventDefault();
    if (isPanning) return;

    let clientX, clientY;
    if ('touches' in e) {
        const touch = e.touches[0] || e.changedTouches[0];
        clientX = touch.clientX;
        clientY = touch.clientY;
    } else {
        clientX = (e as React.MouseEvent).clientX;
        clientY = (e as React.MouseEvent).clientY;
    }

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    // Determine alignment availability
    const selectedCount = state.selectedNodeIds.length;
    const canAlign = selectedCount > 1;
    const canDistribute = selectedCount > 2;

    setContextMenu({
        x: clientX,
        y: clientY,
        targetNodeId: nodeId,
        targetPortId: portId,
        targetNode: nodeId ? state.nodes.find(n => n.id === nodeId) : undefined,
        canAlignHorizontal: canAlign,
        canAlignVertical: canAlign,
        canDistributeHorizontal: canDistribute,
        canDistributeVertical: canDistribute,
        canCompactHorizontal: canAlign,
        canCompactVertical: canAlign
    });
  };

  const isConnected = useCallback((portId: string) => {
      return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
  }, [state.connections]);

  const handleToggleRun = (nodeId: string) => {
      const isRunning = state.runningPreviewIds.includes(nodeId);
      dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId, isRunning: !isRunning } });
  };

  const handleRefresh = (nodeId: string) => {
      const iframe = document.getElementById(`preview-iframe-${nodeId}`) as HTMLIFrameElement;
      if (iframe) {
          iframe.srcdoc = compilePreview(nodeId, state.nodes, state.connections, true);
      }
  };

  const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
      e.stopPropagation();
      e.preventDefault();
      
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;

      const portPos = calculatePortPosition(node, portId, isInput ? 'input' : 'output');
      
      setDragWire({
          x1: portPos.x,
          y1: portPos.y,
          x2: portPos.x,
          y2: portPos.y,
          startPortId: portId,
          startNodeId: nodeId,
          isInput
      });
  };

  const handlePortContextMenu = (e: React.MouseEvent, portId: string) => {
      e.stopPropagation();
      e.preventDefault();
      handleContextMenu(e, undefined, portId);
  };

  const handleBgPointerDown = (e: React.PointerEvent) => {
      // Allow Middle Click (1) for Panning, Left Click (0) for Standard interactions
      if (e.button !== 0 && e.button !== 1) return; 

      if ((e.target as HTMLElement).closest('.nodrag')) return;
      
      // Clear selection only on Left Click without modifiers
      if (e.button === 0 && !e.shiftKey && !e.ctrlKey) {
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [] });
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      
      // Selection Box (Left Click + Modifier)
      if (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          const rect = containerRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          setSelectionBox({ x, y, w: 0, h: 0, startX: x, startY: y });
      } else {
          // Pan on Left Drag (no mod) OR Middle Drag
          setIsPanning(true);
          dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
      if (dragWire) {
          const rect = containerRef.current!.getBoundingClientRect();
          const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
          const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
          setDragWire({ ...dragWire, x2: x, y2: y });
          return;
      }

      if (isPanning && dragStartRef.current) {
          const dx = e.clientX - dragStartRef.current.x;
          const dy = e.clientY - dragStartRef.current.y;
          dispatch({ type: 'PAN', payload: { x: state.pan.x + dx, y: state.pan.y + dy } });
          dragStartRef.current = { x: e.clientX, y: e.clientY };
          return;
      }

      if (selectionBox) {
          const rect = containerRef.current!.getBoundingClientRect();
          const currentX = e.clientX - rect.left;
          const currentY = e.clientY - rect.top;
          
          const x = Math.min(selectionBox.startX, currentX);
          const y = Math.min(selectionBox.startY, currentY);
          const w = Math.abs(currentX - selectionBox.startX);
          const h = Math.abs(currentY - selectionBox.startY);
          
          setSelectionBox({ ...selectionBox, x, y, w, h });
      }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture(e.pointerId);

      if (dragWire) {
          const element = document.elementFromPoint(e.clientX, e.clientY);
          const portDiv = element?.closest('[data-port-id]');
          
          if (portDiv) {
              const targetPortId = portDiv.getAttribute('data-port-id');
              const targetNodeId = portDiv.getAttribute('data-node-id');
              
              if (targetPortId && targetNodeId && targetNodeId !== dragWire.startNodeId) {
                  let sourceNodeId = dragWire.startNodeId;
                  let sourcePortId = dragWire.startPortId;
                  let finalTargetNodeId = targetNodeId;
                  let finalTargetPortId = targetPortId;

                  if (dragWire.isInput) {
                       sourceNodeId = targetNodeId;
                       sourcePortId = targetPortId;
                       finalTargetNodeId = dragWire.startNodeId;
                       finalTargetPortId = dragWire.startPortId;
                  }
                  
                  dispatchLocal({ 
                      type: 'CONNECT', 
                      payload: { 
                          id: `conn-${Date.now()}`, 
                          sourceNodeId, 
                          sourcePortId, 
                          targetNodeId: finalTargetNodeId, 
                          targetPortId: finalTargetPortId 
                      } 
                  });
              }
          }
          setDragWire(null);
      }

      setIsPanning(false);
      dragStartRef.current = null;

      if (selectionBox) {
          const worldX = (selectionBox.x - state.pan.x) / state.zoom;
          const worldY = (selectionBox.y - state.pan.y) / state.zoom;
          const worldW = selectionBox.w / state.zoom;
          const worldH = selectionBox.h / state.zoom;
          
          const selected = state.nodes.filter(n => {
              const nx = n.position.x;
              const ny = n.position.y;
              const nw = n.size.width;
              const nh = n.isMinimized ? 40 : n.size.height;
              
              return (
                  nx < worldX + worldW &&
                  nx + nw > worldX &&
                  ny < worldY + worldH &&
                  ny + nh > worldY
              );
          }).map(n => n.id);
          
          if (selected.length > 0) {
              dispatchLocal({ type: 'SET_SELECTED_NODES', payload: selected });
          }
          setSelectionBox(null);
      }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
          // Native listener already handles preventDefault
          isPinching.current = true;
          const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
          );
          lastTouchDist.current = dist;
      } else if (e.touches.length === 1) {
           touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
      if (isPinching.current && e.touches.length === 2) {
          const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
          );
          
          if (lastTouchDist.current) {
              const delta = dist - lastTouchDist.current;
              const zoomFactor = delta * 0.005;
              const newZoom = Math.min(Math.max(0.1, state.zoom + zoomFactor), 5);
              
              const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
              const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
              
              const rect = containerRef.current!.getBoundingClientRect();
              const mouseX = centerX - rect.left;
              const mouseY = centerY - rect.top;
              
              const dx = (mouseX - state.pan.x) / state.zoom;
              const dy = (mouseY - state.pan.y) / state.zoom;
              
              const newPanX = mouseX - dx * newZoom;
              const newPanY = mouseY - dy * newZoom;
              
              dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
              dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
          }
          lastTouchDist.current = dist;
      }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
      isPinching.current = false;
      lastTouchDist.current = null;
  };

  const handleAlign = (type: 'horizontal' | 'vertical') => {
      if (state.selectedNodeIds.length < 2) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      
      if (type === 'horizontal') {
          const avgY = nodes.reduce((sum, n) => sum + n.position.y + n.size.height/2, 0) / nodes.length;
          nodes.forEach(n => {
              const newY = avgY - n.size.height/2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: newY } } });
          });
      } else {
          const avgX = nodes.reduce((sum, n) => sum + n.position.x + n.size.width/2, 0) / nodes.length;
          nodes.forEach(n => {
              const newX = avgX - n.size.width/2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: newX, y: n.position.y } } });
          });
      }
      setContextMenu(null);
  };

  const handleDistribute = (type: 'horizontal' | 'vertical') => {
      if (state.selectedNodeIds.length < 3) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      
      if (type === 'horizontal') {
          nodes.sort((a, b) => a.position.x - b.position.x);
          const start = nodes[0].position.x;
          const end = nodes[nodes.length - 1].position.x;
          const totalDist = end - start;
          const gap = totalDist / (nodes.length - 1);
          
          nodes.forEach((n, i) => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: start + (gap * i), y: n.position.y } } });
          });
      } else {
          nodes.sort((a, b) => a.position.y - b.position.y);
          const start = nodes[0].position.y;
          const end = nodes[nodes.length - 1].position.y;
          const totalDist = end - start;
          const gap = totalDist / (nodes.length - 1);
          
          nodes.forEach((n, i) => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: start + (gap * i) } } });
          });
      }
      setContextMenu(null);
  };

  const handleCompact = (type: 'horizontal' | 'vertical') => {
      if (state.selectedNodeIds.length < 2) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      const PADDING = 20;

      if (type === 'horizontal') {
          nodes.sort((a, b) => a.position.x - b.position.x);
          let currentX = nodes[0].position.x;
          nodes.forEach(n => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: currentX, y: n.position.y } } });
              currentX += n.size.width + PADDING;
          });
      } else {
          nodes.sort((a, b) => a.position.y - b.position.y);
          let currentY = nodes[0].position.y;
          nodes.forEach(n => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: currentY } } });
              const h = n.isMinimized ? 40 : n.size.height;
              currentY += h + PADDING;
          });
      }
      setContextMenu(null);
  };

  const checkPermission = (nodeId: string): boolean => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return false;
      if (!node.lockedBy) return true;
      if (currentUser && node.lockedBy.uid === currentUser.uid) return true;
      alert(`This file is locked by "${node.lockedBy.displayName}".`);
      return false;
  };

  const handleReset = async () => {
      const pwd = prompt("Enter password to reset project:");
      if (pwd !== "password") { if (pwd !== null) alert("Incorrect password."); return; }
      if (!confirm("Are you sure? This will delete all local and cloud data for this project.")) return;
      setSyncStatus('saving');
      try { if (currentUser) await deleteDoc(doc(db, "nodecode_projects", currentUser.uid)); } catch (e) { console.error(e); }
      localStorage.removeItem('nodecode_project_local');
      window.location.reload();
  };

  const handleHighlightNode = (id: string) => { setHighlightedNodeId(id); setTimeout(() => { setHighlightedNodeId(null); }, 2000); };
  const handleStartContextSelection = (nodeId: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: true, requestingNodeId: nodeId, selectedIds: node?.contextNodeIds || [] } });
      setIsSidebarOpen(true);
  };
  const handleToggleSelection = (nodeId: string) => {
      if (!state.selectionMode?.isActive) return;
      const current = state.selectionMode.selectedIds;
      const next = current.includes(nodeId) ? current.filter(id => id !== nodeId) : [...current, nodeId];
      dispatch({ type: 'SET_SELECTION_MODE', payload: { ...state.selectionMode, selectedIds: next } });
  };
  const handleConfirmSelection = () => {
      if (!state.selectionMode?.isActive) return;
      dispatch({ type: 'UPDATE_CONTEXT_NODES', payload: { id: state.selectionMode.requestingNodeId, nodeIds: state.selectionMode.selectedIds } });
      dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: false } });
      setIsSidebarOpen(false);
  };

  // --- AI HANDLERS VIA MANAGER ---
  const handleSendMessageWrapper = async (nodeId: string, text: string) => {
      await handleAiMessage(nodeId, text, {
          state,
          dispatch: dispatchLocal,
          checkPermission,
          onHighlight: handleHighlightNode
      });
  };

  const handleAiGenerateWrapper = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
      await handleAiGeneration(nodeId, action, promptText, {
          state,
          dispatch: dispatchLocal,
          checkPermission,
          onHighlight: handleHighlightNode
      });
  };

  const handleCancelAi = (nodeId: string) => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
  
  const handleFixError = (nodeId: string, error: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const connectedPreview = getConnectedSource(nodeId, 'logs', state.nodes, state.connections);
      if (!connectedPreview) return;
      const connectedCode = getConnectedSource(connectedPreview.id, 'dom', state.nodes, state.connections);
      if (!connectedCode || !checkPermission(connectedCode.id)) return;
      handleAiGenerateWrapper(connectedCode.id, 'prompt', `Fix this error: ${error}`);
  };
  
  const handleInjectImport = (sourceNodeId: string, packageName: string) => {
      const connections = state.connections.filter(c => c.sourceNodeId === sourceNodeId);
      connections.forEach(conn => {
          const target = state.nodes.find(n => n.id === conn.targetNodeId);
          if (target && target.type === 'CODE' && checkPermission(target.id)) {
              const stmt = `import * as ${packageName.replace(/[^a-zA-Z0-9]/g, '_')} from 'https://esm.sh/${packageName}';\n`;
              if (!target.content.includes(stmt)) { dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: stmt + target.content } }); handleHighlightNode(target.id); }
          }
      });
  };

  const handleToggleSelectNode = (id: string, multi: boolean) => {
      if (multi) {
          const selected = state.selectedNodeIds.includes(id) ? state.selectedNodeIds.filter(nid => nid !== id) : [...state.selectedNodeIds, id];
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: selected });
      } else { dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [id] }); }
  };

  const handleAddNode = (type: NodeType) => {
    if (!contextMenu) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (contextMenu.x - rect.left - state.pan.x) / state.zoom;
    const y = (contextMenu.y - rect.top - state.pan.y) / state.zoom;
    const defaults = NODE_DEFAULTS[type];
    const newNode: NodeData = { id: `node-${Date.now()}`, type, title: defaults.title, content: defaults.content, position: { x, y }, size: { width: defaults.width, height: defaults.height }, autoHeight: type === 'CODE' ? false : undefined };
    dispatchLocal({ type: 'ADD_NODE', payload: newNode });
    setContextMenu(null);
  };

  const handleClearImage = (id: string) => { if (checkPermission(id)) { dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content: '' } }); setContextMenu(null); } };
  
  const handleUpdateTitle = (id: string, newTitle: string) => {
      if (!checkPermission(id)) return;
      const node = state.nodes.find(n => n.id === id);
      if (!node) return;
      const ext = newTitle.split('.').pop()?.toLowerCase();
      const codeExts = ['html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'css', 'json', 'txt', 'md'];
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];
      let newType = node.type;
      
      // Keep Folder type if manually set, otherwise guess
      if (node.type !== 'FOLDER') {
        if (codeExts.includes(ext || '')) newType = 'CODE'; else if (imageExts.includes(ext || '')) newType = 'IMAGE';
      }
      
      dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title: newTitle } });
      if (newType !== node.type) dispatchLocal({ type: 'UPDATE_NODE_TYPE', payload: { id, type: newType } });
  };
  
  const handleToggleLock = (nodeId: string) => {
      if (!currentUser) return;
      let targets = [nodeId];
      if (state.selectedNodeIds.includes(nodeId)) targets = state.selectedNodeIds;
      const targetNode = state.nodes.find(n => n.id === nodeId);
      if (!targetNode) return;
      const isLocking = !targetNode.lockedBy;
      const validIds = targets.filter(id => {
          const node = state.nodes.find(n => n.id === id);
          if (!node) return false;
          if (isLocking) return !node.lockedBy; else return node.lockedBy?.uid === currentUser.uid;
      });
      if (validIds.length > 0) { dispatchLocal({ type: 'LOCK_NODES', payload: { ids: validIds, user: isLocking ? currentUser : undefined } }); }
      setContextMenu(null);
  };

  const handleForceUnlock = (nodeId: string) => {
      if (!confirm("Force unlock this node? This will remove the lock for everyone.")) return;
      dispatchLocal({ type: 'LOCK_NODES', payload: { ids: [nodeId], user: undefined } }); // undefined removes lock
      setContextMenu(null);
  };

  const handleDownloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("project");
    state.nodes.forEach(node => {
        if (node.type === 'CODE') {
            folder?.file(node.title, node.content);
        }
    });
    const content = await zip.generateAsync({ type: "blob" });
    const url = window.URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = "project.zip";
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleFindNearest = () => {
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    const worldCenterX = (viewportCenterX - state.pan.x) / state.zoom;
    const worldCenterY = (viewportCenterY - state.pan.y) / state.zoom;
    
    let nearestNode: NodeData | null = null;
    let minDist = Infinity;
    
    regularNodes.forEach(n => {
        const nW = n.size.width;
        const nH = n.isMinimized ? 40 : n.size.height;
        const nCenterX = n.position.x + nW / 2;
        const nCenterY = n.position.y + nH / 2;
        
        const dist = Math.hypot(nCenterX - worldCenterX, nCenterY - worldCenterY);
        if (dist < minDist) { minDist = dist; nearestNode = n; }
    });

    if (nearestNode) {
        const target = nearestNode as NodeData;
        handleHighlightNode(target.id);
        const nW = target.size.width;
        const nH = target.isMinimized ? 40 : target.size.height;
        const targetCenterX = target.position.x + nW / 2;
        const targetCenterY = target.position.y + nH / 2;
        
        const newPanX = viewportCenterX - (targetCenterX * state.zoom);
        const newPanY = viewportCenterY - (targetCenterY * state.zoom);
        
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    }
  };

  const handleNodeMove = useCallback((id: string, newPos: Position) => {
      dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: newPos } });
      
      if (state.selectedNodeIds.includes(id)) {
           const initialNode = state.nodes.find(n => n.id === id);
           const startX = initialNode?.position.x || 0;
           const startY = initialNode?.position.y || 0;
           const deltaX = newPos.x - startX;
           const deltaY = newPos.y - startY;

           state.selectedNodeIds.forEach(otherId => {
               if (otherId !== id) {
                   const other = state.nodes.find(n => n.id === otherId);
                   if (other) {
                       dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: otherId, position: { x: other.position.x + deltaX, y: other.position.y + deltaY } } });
                   }
               }
           });
      }
      
      const SNAP_THRESHOLD = 5;
      const otherNodes = regularNodes.filter(n => n.id !== id && !state.selectedNodeIds.includes(n.id));
      const myNode = regularNodes.find(n => n.id === id);
      if (!myNode) return;
      
      const myW = myNode.size.width;
      const myH = myNode.isMinimized ? 40 : myNode.size.height;
      const myCenterX = newPos.x + myW / 2;
      const myCenterY = newPos.y + myH / 2;

      const newSnapLines: {x1: number, y1: number, x2: number, y2: number}[] = [];

      otherNodes.forEach(other => {
          const otherW = other.size.width;
          const otherH = other.isMinimized ? 40 : other.size.height;
          const otherCenterX = other.position.x + otherW / 2;
          const otherCenterY = other.position.y + otherH / 2;

          if (Math.abs(newPos.x - other.position.x) < SNAP_THRESHOLD) {
              newSnapLines.push({ x1: other.position.x, y1: Math.min(newPos.y, other.position.y) - 20, x2: other.position.x, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          } else if (Math.abs(myCenterX - otherCenterX) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: otherCenterX, y1: Math.min(newPos.y, other.position.y) - 20, x2: otherCenterX, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          } else if (Math.abs((newPos.x + myW) - (other.position.x + otherW)) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: other.position.x + otherW, y1: Math.min(newPos.y, other.position.y) - 20, x2: other.position.x + otherW, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          }

           if (Math.abs(newPos.y - other.position.y) < SNAP_THRESHOLD) {
              newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: other.position.y, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: other.position.y });
          } else if (Math.abs(myCenterY - otherCenterY) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: otherCenterY, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: otherCenterY });
          } else if (Math.abs((newPos.y + myH) - (other.position.y + otherH)) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: other.position.y + otherH, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: other.position.y + otherH });
          }
      });
      setSnapLines(newSnapLines);
  }, [state.nodes, state.selectedNodeIds, regularNodes]);
  
  const handleNodeDragEnd = (id: string) => { setSnapLines([]); };

  // ... (Render)
  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3">
        <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">Coding Arena</h1>
            <p className="text-xs font-medium text-zinc-500">Local Session</p>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/80 border border-zinc-800 rounded-full backdrop-blur-sm pointer-events-auto" title="Cloud Sync Status">
            {syncStatus === 'synced' && <Cloud size={14} className="text-emerald-500" />}
            {syncStatus === 'saving' && <UploadCloud size={14} className="text-amber-500 animate-pulse" />}
            {syncStatus === 'offline' && <CloudOff size={14} className="text-zinc-500" />}
            {syncStatus === 'error' && <CloudOff size={14} className="text-red-500" />}
            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400">
                {syncStatus === 'synced' ? 'Live' : syncStatus === 'saving' ? 'Syncing...' : 'Offline'}
            </span>
        </div>
      </div>

      <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 items-end">
        <button 
            onClick={handleReset}
            className="px-3 py-1.5 bg-red-900/80 hover:bg-red-800 text-xs font-medium text-red-100 border border-red-700 rounded flex items-center gap-2 transition-colors pointer-events-auto cursor-pointer shadow-lg"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <AlertTriangle size={12} /> Reset Project
        </button>
        <button 
            onClick={() => setIsSidebarOpen(true)}
            className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <Menu size={16} />
        </button>
        <button 
            onClick={handleDownloadZip}
            className="px-3 py-2 bg-zinc-900/80 hover:bg-blue-600/50 text-xs text-zinc-400 hover:text-white border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
            title="Download Project ZIP"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <Download size={16} />
        </button>
        <button 
            onClick={handleFindNearest}
            className="px-3 py-2 bg-zinc-900/80 hover:bg-emerald-600/50 text-xs text-zinc-400 hover:text-white border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
            title="Find Nearest Module"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <Search size={16} />
        </button>
      </div>

      <Sidebar 
        isOpen={isSidebarOpen} 
        nodes={state.nodes} 
        onNodeClick={handleHighlightNode} 
        onClose={() => setIsSidebarOpen(false)}
        selectionMode={state.selectionMode?.isActive ? {
            isActive: true,
            selectedIds: state.selectionMode.selectedIds,
            onToggle: handleToggleSelection,
            onConfirm: handleConfirmSelection
        } : undefined}
      />

      <div 
        ref={containerRef}
        id="canvas-bg"
        className="flex-1 relative cursor-grab active:cursor-grabbing"
        onContextMenu={(e) => handleContextMenu(e)}
        onPointerDown={handleBgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
            backgroundImage: 'radial-gradient(#3f3f46 2px, transparent 2px)',
            backgroundSize: `${Math.max(20 * state.zoom, 10)}px ${Math.max(20 * state.zoom, 10)}px`,
            backgroundPosition: `${state.pan.x}px ${state.pan.y}px`,
            touchAction: 'none'
        }}
      >
        {/* Selection Box Rendered Outside Transform Context to Fix Scaling/Origin Bug */}
        {selectionBox && (
            <div 
                className="absolute bg-blue-500/10 border border-blue-500 z-[999]"
                style={{
                    left: selectionBox.x,
                    top: selectionBox.y,
                    width: selectionBox.w,
                    height: selectionBox.h,
                    pointerEvents: 'none'
                }}
            />
        )}

        <div 
            style={{ 
                transform: `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`,
                transformOrigin: '0 0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                transition: isPanning ? 'none' : 'transform 0.6s cubic-bezier(0.25, 1, 0.5, 1)' 
            }}
        >
            <div className="pointer-events-none w-full h-full relative">
                
                <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                    {snapLines.map((line, i) => (
                        <line 
                            key={`snap-${i}`}
                            x1={line.x1} y1={line.y1} 
                            x2={line.x2} y2={line.y2}
                            stroke="#22d3ee" 
                            strokeWidth="2"
                            strokeDasharray="5,5"
                            className="opacity-80 animate-in fade-in duration-75"
                        />
                    ))}

                    {state.connections.map(conn => {
                        if (hiddenNodeIds.has(conn.sourceNodeId) || hiddenNodeIds.has(conn.targetNodeId)) return null;

                        const sourceNode = regularNodes.find(n => n.id === conn.sourceNodeId);
                        const targetNode = regularNodes.find(n => n.id === conn.targetNodeId);
                        if (!sourceNode || !targetNode) return null;
                        const start = calculatePortPosition(sourceNode, conn.sourcePortId, 'output');
                        const end = calculatePortPosition(targetNode, conn.targetPortId, 'input');
                        return <Wire key={conn.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
                    })}
                </svg>

                {regularNodes.map(node => {
                    let logs: LogEntry[] = [];
                    let folderContents: string[] = [];
                    
                    if (node.type === 'TERMINAL') {
                         const sources = state.connections.filter(c => c.targetNodeId === node.id).map(c => c.sourceNodeId);
                         logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                    }
                    
                    if (node.type === 'FOLDER') {
                        folderContents = state.connections
                            .filter(c => c.targetNodeId === node.id && c.targetPortId.includes('in-files'))
                            .map(c => state.nodes.find(n => n.id === c.sourceNodeId)?.title)
                            .filter((t): t is string => !!t);
                    }
                    
                    return (
                        <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                            <Node
                                data={node}
                                isSelected={state.selectedNodeIds.includes(node.id)}
                                isHighlighted={node.id === highlightedNodeId}
                                isRunning={state.runningPreviewIds.includes(node.id)}
                                isMaximized={false}
                                scale={state.zoom}
                                isConnected={isConnected}
                                onMove={handleNodeMove}
                                onDragEnd={handleNodeDragEnd}
                                onResize={(id, size) => dispatchLocal({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                onDelete={(id) => {
                                    if(checkPermission(id)) {
                                        dispatchLocal({ type: 'DELETE_NODE', payload: id });
                                    }
                                }}
                                onToggleRun={handleToggleRun}
                                onRefresh={handleRefresh}
                                onPortDown={handlePortDown}
                                onPortContextMenu={handlePortContextMenu}
                                onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}
                                onUpdateTitle={handleUpdateTitle}
                                onUpdateContent={(id, content) => {
                                    if(checkPermission(id)) {
                                        dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content } });
                                    }
                                }}
                                onSendMessage={handleSendMessageWrapper}
                                onStartContextSelection={handleStartContextSelection}
                                onAiAction={handleAiGenerateWrapper}
                                onCancelAi={handleCancelAi}
                                onInjectImport={handleInjectImport}
                                onFixError={handleFixError}
                                onInteraction={(id, type) => dispatch({ type: 'SET_NODE_INTERACTION', payload: { nodeId: id, type } })}
                                onToggleMinimize={(id) => dispatchLocal({ type: 'TOGGLE_MINIMIZE', payload: { id } })}
                                onToggleMaximize={(id) => setMaximizedNodeId(maximizedNodeId === id ? null : id)}
                                onSelect={handleToggleSelectNode}
                                logs={logs}
                                folderContents={folderContents}
                            >
                            </Node>
                        </div>
                    );
                })}

                {dragWire && (
                    <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none" style={{ zIndex: 999 }}>
                        <Wire x1={dragWire.x1} y1={dragWire.y1} x2={dragWire.x2} y2={dragWire.y2} active />
                    </svg>
                )}
            </div>
        </div>
      </div>

      {maximizedNode && (
          <div className="fixed inset-0 z-[9999] bg-black">
              <Node
                  key={maximizedNode.id}
                  data={maximizedNode}
                  isSelected={false}
                  isHighlighted={false}
                  isRunning={state.runningPreviewIds.includes(maximizedNode.id)}
                  isMaximized={true}
                  scale={1}
                  isConnected={() => false}
                  onMove={() => {}}
                  onResize={() => {}}
                  onDelete={() => {}}
                  onToggleRun={handleToggleRun}
                  onRefresh={handleRefresh}
                  onPortDown={() => {}}
                  onPortContextMenu={() => {}}
                  onContextMenu={() => {}}
                  onUpdateTitle={() => {}}
                  onUpdateContent={() => {}}
                  onSendMessage={() => {}}
                  onStartContextSelection={() => {}}
                  onAiAction={() => {}}
                  onCancelAi={() => {}}
                  onInjectImport={() => {}}
                  onFixError={() => {}}
                  onInteraction={() => {}}
                  onToggleMinimize={() => {}}
                  onToggleMaximize={() => setMaximizedNodeId(null)}
                  onSelect={() => {}}
                  logs={[]}
              />
          </div>
      )}

      {contextMenu && (
        <>
            <div className="fixed inset-0 z-40" onClick={() => setContextMenu(null)} />
            <ContextMenu 
                position={contextMenu} 
                targetNodeId={contextMenu.targetNodeId}
                targetNode={contextMenu.targetNode}
                targetPortId={contextMenu.targetPortId}
                selectedNodeIds={state.selectedNodeIds}
                onAdd={handleAddNode} 
                onDeleteNode={(id) => { 
                    if(checkPermission(id)) {
                        dispatchLocal({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); 
                    }
                }}
                onDuplicateNode={(id) => { 
                    const node = state.nodes.find(n => n.id === id);
                    if (node) {
                        const offset = 30;
                        const newNode: NodeData = {
                            ...node,
                            id: `node-${Date.now()}`,
                            position: { x: node.position.x + offset, y: node.position.y + offset },
                            title: `${node.title} (Copy)`,
                            lockedBy: undefined 
                        };
                        dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                    }
                    setContextMenu(null); 
                }}
                onDisconnect={(id) => { 
                    if (contextMenu.targetPortId) {
                        dispatchLocal({ type: 'DISCONNECT', payload: id }); setContextMenu(null); 
                    }
                }}
                onClearImage={handleClearImage}
                onAlign={handleAlign}
                onDistribute={handleDistribute}
                onCompact={handleCompact}
                onToggleLock={handleToggleLock}
                onForceUnlock={handleForceUnlock}
                currentUser={currentUser}
                canAlignHorizontal={(contextMenu as any).canAlignHorizontal}
                canAlignVertical={(contextMenu as any).canAlignVertical}
                canDistributeHorizontal={(contextMenu as any).canDistributeHorizontal}
                canDistributeVertical={(contextMenu as any).canDistributeVertical}
                canCompactHorizontal={(contextMenu as any).canCompactHorizontal}
                canCompactVertical={(contextMenu as any).canCompactVertical}
                onClose={() => setContextMenu(null)} 
            />
        </>
      )}
    </div>
  );
}
