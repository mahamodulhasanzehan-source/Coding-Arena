
import React, { useReducer, useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { GraphState, Action, NodeData, NodeType, LogEntry, Position } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition, getConnectedSource, getAllConnectedSources } from './utils/graphUtils';
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
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
        if (e.touches.length === 2) { e.preventDefault(); }
    };

    const onTouchMove = (e: TouchEvent) => {
        if (e.touches.length === 2) { e.preventDefault(); }
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchmove', onTouchMove);
    };
  }, []); 

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.source === 'preview-iframe') {
        const { nodeId, type, message, timestamp } = e.data;
        dispatch({ type: 'ADD_LOG', payload: { nodeId, log: { type, message, timestamp } } });
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

  useEffect(() => {
      const currentContentHash = JSON.stringify({
          nodes: state.nodes.map(n => ({ id: n.id, title: n.title, content: n.content, type: n.type })),
          connections: state.connections,
          running: state.runningPreviewIds
      });

      if (currentContentHash === lastContentHash.current) return;
      lastContentHash.current = currentContentHash;

      state.runningPreviewIds.forEach(previewId => {
          if (compileTimeoutRef.current[previewId]) clearTimeout(compileTimeoutRef.current[previewId]);
          compileTimeoutRef.current[previewId] = setTimeout(() => {
              const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
              if (iframe) {
                  const compiled = compilePreview(previewId, state.nodes, state.connections);
                  if (iframe.srcdoc !== compiled) iframe.srcdoc = compiled;
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
                  if (childNode && childNode.type === 'FOLDER') traverse(childId);
              }
          });
      };
      state.nodes.forEach(node => {
          if (node.type === 'FOLDER' && node.isMinimized) traverse(node.id);
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

  // --- Alignment Collision Check ---
  const checkAlignmentCollision = (type: 'horizontal' | 'vertical', selectedIds: string[]): boolean => {
      const selected = state.nodes.filter(n => selectedIds.includes(n.id));
      if (selected.length < 2) return false;
      const unselected = state.nodes.filter(n => !selectedIds.includes(n.id) && !hiddenNodeIds.has(n.id));

      let targetPos: Record<string, Position> = {};
      
      if (type === 'horizontal') {
          // Align centers vertically (Y-axis)
          const avgY = selected.reduce((sum, n) => sum + n.position.y + (n.isMinimized ? 40 : n.size.height)/2, 0) / selected.length;
          selected.forEach(n => {
              const h = n.isMinimized ? 40 : n.size.height;
              targetPos[n.id] = { x: n.position.x, y: avgY - h/2 };
          });
      } else {
          // Align centers horizontally (X-axis)
          const avgX = selected.reduce((sum, n) => sum + n.position.x + n.size.width/2, 0) / selected.length;
          selected.forEach(n => {
              const w = n.size.width;
              targetPos[n.id] = { x: avgX - w/2, y: n.position.y };
          });
      }

      // Check collisions
      const allToCheck = [...selected.map(n => ({...n, position: targetPos[n.id]})), ...unselected];
      
      for (let i = 0; i < selected.length; i++) {
          const s = selected[i];
          const sPos = targetPos[s.id];
          const sW = s.size.width;
          const sH = s.isMinimized ? 40 : s.size.height;

          // Check against all other nodes (including other selected nodes at their NEW positions)
          for (let j = 0; j < allToCheck.length; j++) {
              const other = allToCheck[j];
              if (other.id === s.id) continue;
              
              const oW = other.size.width;
              const oH = other.isMinimized ? 40 : other.size.height;
              
              const overlap = (
                  sPos.x < other.position.x + oW &&
                  sPos.x + sW > other.position.x &&
                  sPos.y < other.position.y + oH &&
                  sPos.y + sH > other.position.y
              );
              
              if (overlap) return true; // Collision detected
          }
      }
      return false;
  };


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
    
    // Determine alignment availability with Collision Check
    const selectedCount = state.selectedNodeIds.length;
    
    // Default collision assumption is true (blocked) if we can't calculate, but actually we default to false (allowed) if safe
    const isSafeHorizontal = selectedCount > 1 ? !checkAlignmentCollision('horizontal', state.selectedNodeIds) : false;
    const isSafeVertical = selectedCount > 1 ? !checkAlignmentCollision('vertical', state.selectedNodeIds) : false;
    const canDistribute = selectedCount > 2;

    setContextMenu({
        x: clientX,
        y: clientY,
        targetNodeId: nodeId,
        targetPortId: portId,
        targetNode: nodeId ? state.nodes.find(n => n.id === nodeId) : undefined,
        canAlignHorizontal: isSafeHorizontal,
        canAlignVertical: isSafeVertical,
        canDistributeHorizontal: canDistribute, // Simple check for now
        canDistributeVertical: canDistribute,
        canCompactHorizontal: isSafeHorizontal,
        canCompactVertical: isSafeVertical
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
      if (iframe) iframe.srcdoc = compilePreview(nodeId, state.nodes, state.connections, true);
  };

  const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
      e.stopPropagation(); e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const portPos = calculatePortPosition(node, portId, isInput ? 'input' : 'output');
      setDragWire({ x1: portPos.x, y1: portPos.y, x2: portPos.x, y2: portPos.y, startPortId: portId, startNodeId: nodeId, isInput });
  };

  const handlePortContextMenu = (e: React.MouseEvent, portId: string) => {
      e.stopPropagation(); e.preventDefault();
      handleContextMenu(e, undefined, portId);
  };

  const handleBgPointerDown = (e: React.PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return; 
      if ((e.target as HTMLElement).closest('.nodrag')) return;
      if (e.button === 0 && !e.shiftKey && !e.ctrlKey) { dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [] }); }
      e.currentTarget.setPointerCapture(e.pointerId);
      if (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          const rect = containerRef.current!.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          setSelectionBox({ x, y, w: 0, h: 0, startX: x, startY: y });
      } else {
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
                  dispatchLocal({ type: 'CONNECT', payload: { id: `conn-${Date.now()}`, sourceNodeId, sourcePortId, targetNodeId: finalTargetNodeId, targetPortId: finalTargetPortId } });
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
              return (nx < worldX + worldW && nx + nw > worldX && ny < worldY + worldH && ny + nh > worldY);
          }).map(n => n.id);
          if (selected.length > 0) { dispatchLocal({ type: 'SET_SELECTED_NODES', payload: selected }); }
          setSelectionBox(null);
      }
  };

  const handleAlign = (type: 'horizontal' | 'vertical') => {
      // Re-verify collision before applying
      if (checkAlignmentCollision(type, state.selectedNodeIds)) {
          alert("Cannot align: Alignment would cause nodes to overlap.");
          return;
      }
      if (state.selectedNodeIds.length < 2) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      
      if (type === 'horizontal') {
          const avgY = nodes.reduce((sum, n) => sum + n.position.y + (n.isMinimized ? 40 : n.size.height)/2, 0) / nodes.length;
          nodes.forEach(n => {
              const newY = avgY - (n.isMinimized ? 40 : n.size.height)/2;
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

  // ... (handleDistribute, handleCompact remain similar but assume basic math is safe if no collision checker enforced there yet, can be added later)
  const handleDistribute = (type: 'horizontal' | 'vertical') => {
      // ... logic from before
      if (state.selectedNodeIds.length < 3) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      
      if (type === 'horizontal') {
          nodes.sort((a, b) => a.position.x - b.position.x);
          const start = nodes[0].position.x;
          const end = nodes[nodes.length - 1].position.x;
          const totalDist = end - start;
          const gap = totalDist / (nodes.length - 1);
          nodes.forEach((n, i) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: start + (gap * i), y: n.position.y } } }));
      } else {
          nodes.sort((a, b) => a.position.y - b.position.y);
          const start = nodes[0].position.y;
          const end = nodes[nodes.length - 1].position.y;
          const totalDist = end - start;
          const gap = totalDist / (nodes.length - 1);
          nodes.forEach((n, i) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: start + (gap * i) } } }));
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
  const handleSendMessageWrapper = async (nodeId: string, text: string) => {
      await handleAiMessage(nodeId, text, { state, dispatch: dispatchLocal, checkPermission, onHighlight: handleHighlightNode });
  };
  const handleAiGenerateWrapper = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
      await handleAiGeneration(nodeId, action, promptText, { state, dispatch: dispatchLocal, checkPermission, onHighlight: handleHighlightNode });
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
               if (!target.content.includes(packageName)) {
                   const importStatement = `import '${packageName}';`;
                   const newContent = `${importStatement}\n${target.content}`;
                   dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: newContent } });
               }
          }
      });
  };

  return (
    <div 
        ref={containerRef}
        className="w-full h-screen bg-[#09090b] overflow-hidden relative selection-box-container touch-none"
        onPointerDown={handleBgPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={(e) => handleContextMenu(e)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
    >
       {/* Grid Background */}
        <div 
            className="absolute inset-0 pointer-events-none opacity-20"
            style={{
                backgroundImage: 'radial-gradient(#3f3f46 1px, transparent 1px)',
                backgroundSize: `${20 * state.zoom}px ${20 * state.zoom}px`,
                backgroundPosition: `${state.pan.x}px ${state.pan.y}px`
            }}
        />

        {/* Wires */}
        <svg className="absolute inset-0 pointer-events-none overflow-visible w-full h-full">
            <g transform={`translate(${state.pan.x}, ${state.pan.y}) scale(${state.zoom})`}>
                {state.connections.map(conn => {
                    const sourceNode = state.nodes.find(n => n.id === conn.sourceNodeId);
                    const targetNode = state.nodes.find(n => n.id === conn.targetNodeId);
                    if (!sourceNode || !targetNode) return null;
                    
                    const sourcePort = calculatePortPosition(sourceNode, conn.sourcePortId, 'output');
                    const targetPort = calculatePortPosition(targetNode, conn.targetPortId, 'input');
                    
                    return (
                        <Wire 
                            key={conn.id} 
                            x1={sourcePort.x} y1={sourcePort.y} 
                            x2={targetPort.x} y2={targetPort.y} 
                        />
                    );
                })}
                {dragWire && (
                    <Wire 
                        x1={dragWire.x1} y1={dragWire.y1} 
                        x2={dragWire.x2} y2={dragWire.y2} 
                        active 
                    />
                )}
            </g>
        </svg>

        {/* Nodes */}
        {displayNodes.map(node => (
            <Node
                key={node.id}
                data={node}
                scale={state.zoom}
                pan={state.pan}
                isSelected={state.selectedNodeIds.includes(node.id)}
                isHighlighted={highlightedNodeId === node.id}
                isRunning={state.runningPreviewIds.includes(node.id)}
                isMaximized={maximizedNodeId === node.id}
                isConnected={isConnected}
                onMove={(id, pos) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: pos } })}
                onResize={(id, size) => dispatchLocal({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                onDelete={(id) => { if(checkPermission(id)) dispatchLocal({ type: 'DELETE_NODE', payload: id }); }}
                onToggleRun={handleToggleRun}
                onRefresh={handleRefresh}
                onPortDown={handlePortDown}
                onPortContextMenu={handlePortContextMenu}
                onContextMenu={(e) => handleContextMenu(e, node.id)}
                onUpdateTitle={(id, title) => { if(checkPermission(id)) dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title } }); }}
                onUpdateContent={(id, content) => { if(checkPermission(id)) dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content } }); }}
                onSendMessage={handleSendMessageWrapper}
                onStartContextSelection={handleStartContextSelection}
                onAiAction={handleAiGenerateWrapper}
                onCancelAi={handleCancelAi}
                onInjectImport={handleInjectImport}
                onFixError={handleFixError}
                onInteraction={(id, type) => dispatchLocal({ type: 'SET_NODE_INTERACTION', payload: { nodeId: id, type } })}
                onToggleMinimize={(id) => dispatchLocal({ type: 'TOGGLE_MINIMIZE', payload: { id } })}
                onToggleMaximize={(id) => setMaximizedNodeId(maximizedNodeId === id ? null : id)}
                onSelect={(id, multi) => {
                    if (multi) {
                        const newSelected = state.selectedNodeIds.includes(id) 
                            ? state.selectedNodeIds.filter(i => i !== id)
                            : [...state.selectedNodeIds, id];
                        dispatchLocal({ type: 'SET_SELECTED_NODES', payload: newSelected });
                    } else {
                         dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [id] });
                    }
                }}
                collaboratorInfo={
                    state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId) 
                    ? { name: 'Remote User', color: state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId)!.color, action: 'dragging' } 
                    : undefined
                }
                logs={state.logs[node.id]}
                folderContents={
                    node.type === 'FOLDER' 
                    ? state.connections
                        .filter(c => c.targetNodeId === node.id && c.targetPortId.includes('in-files'))
                        .map(c => state.nodes.find(n => n.id === c.sourceNodeId)?.title || 'Unknown')
                    : undefined
                }
            />
        ))}

        {/* Selection Box */}
        {selectionBox && (
            <div 
                className="absolute border border-blue-500 bg-blue-500/20 pointer-events-none z-50"
                style={{
                    left: selectionBox.x,
                    top: selectionBox.y,
                    width: selectionBox.w,
                    height: selectionBox.h
                }}
            />
        )}

        {/* Collaborators */}
        {state.collaborators.map(c => {
            if (c.id === sessionId) return null;
            return <CollaboratorCursor key={c.id} x={c.x * state.zoom + state.pan.x} y={c.y * state.zoom + state.pan.y} color={c.color} />;
        })}

        {/* UI Controls */}
        <div className="fixed top-4 left-4 z-50 flex flex-col gap-2">
            <button 
                onClick={() => setIsSidebarOpen(true)}
                className="p-2 bg-panel border border-panelBorder rounded-lg shadow-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
                <Menu size={20} />
            </button>
             <div className="p-2 bg-panel border border-panelBorder rounded-lg shadow-xl flex flex-col items-center gap-2">
                 <button onClick={() => dispatch({ type: 'ZOOM', payload: { zoom: Math.min(state.zoom + 0.1, 5) } })} className="p-1 hover:bg-zinc-800 rounded text-zinc-400">+</button>
                 <span className="text-[10px] text-zinc-500">{Math.round(state.zoom * 100)}%</span>
                 <button onClick={() => dispatch({ type: 'ZOOM', payload: { zoom: Math.max(state.zoom - 0.1, 0.1) } })} className="p-1 hover:bg-zinc-800 rounded text-zinc-400">-</button>
             </div>
        </div>

        {/* Sync Status Indicator */}
        <div className="fixed bottom-4 left-4 z-50 px-3 py-1.5 bg-panel border border-panelBorder rounded-full shadow-xl flex items-center gap-2 text-xs font-medium text-zinc-400">
             {syncStatus === 'synced' && <Cloud size={14} className="text-emerald-500" />}
             {syncStatus === 'saving' && <UploadCloud size={14} className="text-amber-500 animate-pulse" />}
             {syncStatus === 'error' && <AlertTriangle size={14} className="text-red-500" />}
             {syncStatus === 'offline' && <CloudOff size={14} className="text-zinc-600" />}
             <span>{syncStatus === 'synced' ? 'Saved' : syncStatus === 'saving' ? 'Saving...' : syncStatus === 'error' ? 'Error' : 'Offline'}</span>
             {currentUser && <span className="ml-2 border-l border-zinc-700 pl-2 text-zinc-500">{currentUser.displayName}</span>}
        </div>

        {/* Context Menu */}
        {contextMenu && (
            <ContextMenu 
                position={{ x: contextMenu.x, y: contextMenu.y }}
                targetNodeId={contextMenu.targetNodeId}
                targetNode={contextMenu.targetNode}
                targetPortId={contextMenu.targetPortId}
                selectedNodeIds={state.selectedNodeIds}
                currentUser={currentUser}
                onAdd={(type) => {
                    const id = `node-${Date.now()}`;
                    const defs = NODE_DEFAULTS[type] || { width: 300, height: 300, title: 'Node', content: '' };
                    const pos = { 
                        x: (contextMenu.x - state.pan.x) / state.zoom, 
                        y: (contextMenu.y - state.pan.y) / state.zoom 
                    };
                    dispatchLocal({ type: 'ADD_NODE', payload: { id, type, position: pos, size: { width: defs.width, height: defs.height }, title: defs.title, content: defs.content, autoHeight: (defs as any).autoHeight } });
                    setContextMenu(null);
                }}
                onDeleteNode={(id) => { if(checkPermission(id)) dispatchLocal({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); }}
                onDuplicateNode={(id) => {
                    const original = state.nodes.find(n => n.id === id);
                    if (original) {
                         const newId = `node-${Date.now()}`;
                         dispatchLocal({ type: 'ADD_NODE', payload: { ...original, id: newId, position: { x: original.position.x + 50, y: original.position.y + 50 }, title: `${original.title} (Copy)` } });
                    }
                    setContextMenu(null);
                }}
                onDisconnect={(portId) => {
                     const conns = state.connections.filter(c => c.sourcePortId === portId || c.targetPortId === portId);
                     conns.forEach(c => dispatchLocal({ type: 'DISCONNECT', payload: c.id }));
                     setContextMenu(null);
                }}
                onClearImage={(id) => {
                    if (checkPermission(id)) {
                        dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content: '' } });
                        dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title: 'Image' } });
                    }
                    setContextMenu(null);
                }}
                onAlign={handleAlign}
                onDistribute={handleDistribute}
                onCompact={handleCompact}
                onToggleLock={(id) => {
                    if (!currentUser) return;
                    const idsToToggle = state.selectedNodeIds.includes(id) ? state.selectedNodeIds : [id];
                    const targetNode = state.nodes.find(n => n.id === id);
                    const isLocking = !targetNode?.lockedBy;
                    
                    dispatchLocal({ 
                        type: 'LOCK_NODES', 
                        payload: { 
                            ids: idsToToggle, 
                            user: isLocking ? { uid: currentUser.uid, displayName: currentUser.displayName } : undefined 
                        } 
                    });
                    setContextMenu(null);
                }}
                onForceUnlock={(id) => {
                     dispatchLocal({ type: 'LOCK_NODES', payload: { ids: [id], user: undefined } });
                     setContextMenu(null);
                }}
                canAlignHorizontal={contextMenu.canAlignHorizontal}
                canAlignVertical={contextMenu.canAlignVertical}
                canDistributeHorizontal={contextMenu.canDistributeHorizontal}
                canDistributeVertical={contextMenu.canDistributeVertical}
                canCompactHorizontal={contextMenu.canCompactHorizontal}
                canCompactVertical={contextMenu.canCompactVertical}
                onClose={() => setContextMenu(null)}
            />
        )}
        
        <Sidebar 
            isOpen={isSidebarOpen} 
            nodes={state.nodes} 
            onNodeClick={(id) => {
                const node = state.nodes.find(n => n.id === id);
                if (node) {
                    const centerX = (window.innerWidth / 2 - node.size.width / 2);
                    const centerY = (window.innerHeight / 2 - node.size.height / 2);
                    const newPanX = centerX - node.position.x * state.zoom;
                    const newPanY = centerY - node.position.y * state.zoom;
                    
                    dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
                    setHighlightedNodeId(id);
                    setTimeout(() => setHighlightedNodeId(null), 2000);
                    if (window.innerWidth < 768) setIsSidebarOpen(false);
                }
            }}
            onClose={() => setIsSidebarOpen(false)}
            selectionMode={state.selectionMode?.isActive ? {
                isActive: true,
                selectedIds: state.selectionMode.selectedIds,
                onToggle: handleToggleSelection,
                onConfirm: handleConfirmSelection
            } : undefined}
        />
        
    </div>
  );
}
