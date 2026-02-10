
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

// Helper for collision detection
const checkIntersection = (r1: {x:number, y:number, w:number, h:number}, r2: {x:number, y:number, w:number, h:number}) => {
    return !(r2.x >= r1.x + r1.w || 
             r2.x + r2.w <= r1.x || 
             r2.y >= r1.y + r1.h || 
             r2.y + r2.h <= r1.y);
};

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
    // Load local state
    const saved = localStorage.getItem('nodecode_project_local');
    if (saved) {
        try {
            dispatch({ type: 'LOAD_STATE', payload: JSON.parse(saved) });
        } catch (e) { console.error("Failed to load local state", e); }
    }
  }, []);

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
                  } else { setSyncStatus('synced'); }
              } catch (err) { console.error(err); setSyncStatus('error'); }
          } else { setCurrentUser(null); setSyncStatus('offline'); }
      });
      return () => unsubscribe();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    // Fix: Zoom by default on wheel, prevent scrolling
    const onWheel = (e: WheelEvent) => { 
        e.preventDefault(); 
        const containerRect = container.getBoundingClientRect();
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;

        // Zoom logic
        const zoomFactor = -e.deltaY * 0.001;
        const newZoom = Math.min(Math.max(0.1, stateRef.current.zoom + zoomFactor), 5);
        
        // Calculate pinch/zoom point
        const dx = (mouseX - stateRef.current.pan.x) / stateRef.current.zoom;
        const dy = (mouseY - stateRef.current.pan.y) / stateRef.current.zoom;
        
        const newPanX = mouseX - dx * newZoom;
        const newPanY = mouseY - dy * newZoom;

        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    };

    const onTouchStart = (e: TouchEvent) => { if (e.touches.length === 2) e.preventDefault(); };
    const onTouchMove = (e: TouchEvent) => { if (e.touches.length === 2) e.preventDefault(); };
    
    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => { container.removeEventListener('wheel', onWheel); container.removeEventListener('touchstart', onTouchStart); container.removeEventListener('touchmove', onTouchMove); };
  }, []);
  
  // Listen for iframe messages
  useEffect(() => {
      const handleMessage = (e: MessageEvent) => {
          if (e.data.source === 'preview-iframe' && e.data.nodeId) {
              dispatch({ 
                  type: 'ADD_LOG', 
                  payload: { 
                      nodeId: e.data.nodeId, 
                      log: { type: e.data.type, message: e.data.message, timestamp: e.data.timestamp } 
                  } 
              });
          }
      };
      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
  }, []);

  // --- Live Preview Re-compilation ---
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
              if (iframe) iframe.srcdoc = compilePreview(previewId, state.nodes, state.connections);
          }, 500); 
      });
  }, [state.nodes, state.connections, state.runningPreviewIds]);

  const hiddenNodeIds = useMemo(() => {
      const ids = new Set<string>();
      const getChildren = (folderId: string) => state.connections.filter(c => c.targetNodeId === folderId && c.targetPortId.includes('in-files')).map(c => c.sourceNodeId);
      const traverse = (parentId: string) => { getChildren(parentId).forEach(childId => { if (!ids.has(childId)) { ids.add(childId); const childNode = state.nodes.find(n => n.id === childId); if (childNode && childNode.type === 'FOLDER') traverse(childId); } }); };
      state.nodes.forEach(node => { if (node.type === 'FOLDER' && node.isMinimized) traverse(node.id); });
      return ids;
  }, [state.nodes, state.connections]);

  const displayNodes = useMemo(() => state.nodes.filter(n => !hiddenNodeIds.has(n.id)).map(node => { const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId); if (collaborator && collaborator.draggingPosition) return { ...node, position: collaborator.draggingPosition, _remoteDrag: true }; return node; }), [state.nodes, state.collaborators, sessionId, hiddenNodeIds]);
  const regularNodes = useMemo(() => displayNodes.filter(n => n.id !== maximizedNodeId), [displayNodes, maximizedNodeId]);
  const maximizedNode = useMemo(() => displayNodes.find(n => n.id === maximizedNodeId), [displayNodes, maximizedNodeId]);

  // FIX 2: Collision Logic for Alignment
  const canAlign = (type: 'horizontal' | 'vertical', selectedIds: string[]) => {
      if (selectedIds.length < 2) return false;
      const nodes = state.nodes.filter(n => selectedIds.includes(n.id));
      const otherNodes = state.nodes.filter(n => !selectedIds.includes(n.id));
      
      const newPositions = nodes.map(n => ({ ...n }));
      
      if (type === 'horizontal') {
          const avgY = nodes.reduce((sum, n) => sum + n.position.y + n.size.height/2, 0) / nodes.length;
          newPositions.forEach(n => n.position = { x: n.position.x, y: avgY - n.size.height/2 });
      } else {
          const avgX = nodes.reduce((sum, n) => sum + n.position.x + n.size.width/2, 0) / nodes.length;
          newPositions.forEach(n => n.position = { x: avgX - n.size.width/2, y: n.position.y });
      }

      for (let i = 0; i < newPositions.length; i++) {
          for (let j = i + 1; j < newPositions.length; j++) {
              const r1 = { x: newPositions[i].position.x, y: newPositions[i].position.y, w: newPositions[i].size.width, h: newPositions[i].size.height };
              const r2 = { x: newPositions[j].position.x, y: newPositions[j].position.y, w: newPositions[j].size.width, h: newPositions[j].size.height };
              if (checkIntersection(r1, r2)) return false;
          }
      }

      for (const n of newPositions) {
          for (const o of otherNodes) {
              const r1 = { x: n.position.x, y: n.position.y, w: n.size.width, h: n.size.height };
              const r2 = { x: o.position.x, y: o.position.y, w: o.size.width, h: o.size.height };
              if (checkIntersection(r1, r2)) return false;
          }
      }
      return true;
  };

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent | React.PointerEvent, nodeId?: string, portId?: string) => {
    e.preventDefault();
    if (isPanning) return;
    let clientX, clientY;
    if ('touches' in e) { const touch = e.touches[0] || e.changedTouches[0]; clientX = touch.clientX; clientY = touch.clientY; } else { clientX = (e as React.MouseEvent).clientX; clientY = (e as React.MouseEvent).clientY; }
    
    const selectedIds = state.selectedNodeIds.includes(nodeId || '') ? state.selectedNodeIds : (nodeId ? [nodeId] : []);
    const canAlignH = canAlign('horizontal', selectedIds);
    const canAlignV = canAlign('vertical', selectedIds);

    setContextMenu({
        x: clientX,
        y: clientY,
        targetNodeId: nodeId,
        targetPortId: portId,
        targetNode: nodeId ? state.nodes.find(n => n.id === nodeId) : undefined,
        canAlignHorizontal: canAlignH,
        canAlignVertical: canAlignV,
        canDistributeHorizontal: selectedIds.length > 2,
        canDistributeVertical: selectedIds.length > 2,
        canCompactHorizontal: canAlignH,
        canCompactVertical: canAlignV
    });
  };

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

  // FIX 3: Folder Export Logic
  const handleDownloadZip = async () => {
    const zip = new JSZip();
    const projectFolder = zip.folder("project");
    
    const fileToFolderMap = new Map<string, string>();
    state.connections.forEach(conn => {
        const target = state.nodes.find(n => n.id === conn.targetNodeId);
        if (target?.type === 'FOLDER' && conn.targetPortId.includes('in-files')) {
            fileToFolderMap.set(conn.sourceNodeId, target.title);
        }
    });

    state.nodes.forEach(node => {
        if (node.type === 'CODE' || node.type === 'TEXT' || node.type === 'IMAGE') {
            const folderName = fileToFolderMap.get(node.id);
            let content: string | Blob = node.content;
            
            if (node.type === 'IMAGE' && node.content.startsWith('data:')) {
                const base64Data = node.content.split(',')[1];
                content = base64Data;
                projectFolder?.file(folderName ? `${folderName}/${node.title}` : node.title, content, { base64: true });
            } else {
                projectFolder?.file(folderName ? `${folderName}/${node.title}` : node.title, content);
            }
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

  const handleAlign = (type: 'horizontal' | 'vertical') => {
      if (state.selectedNodeIds.length < 2) return;
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      if (type === 'horizontal') {
          const avgY = nodes.reduce((sum, n) => sum + n.position.y + n.size.height/2, 0) / nodes.length;
          nodes.forEach(n => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: avgY - n.size.height/2 } } }));
      } else {
          const avgX = nodes.reduce((sum, n) => sum + n.position.x + n.size.width/2, 0) / nodes.length;
          nodes.forEach(n => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: avgX - n.size.width/2, y: n.position.y } } }));
      }
      setContextMenu(null);
  };
  
  const handleDistribute = (type: 'horizontal' | 'vertical') => {
      const nodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      if (nodes.length < 3) return;
      if (type === 'horizontal') {
          nodes.sort((a, b) => a.position.x - b.position.x);
          const start = nodes[0].position.x;
          const end = nodes[nodes.length - 1].position.x;
          const total = end - start;
          const gap = total / (nodes.length - 1);
          nodes.forEach((n, i) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: start + (gap * i), y: n.position.y } } }));
      } else {
          nodes.sort((a, b) => a.position.y - b.position.y);
          const start = nodes[0].position.y;
          const end = nodes[nodes.length - 1].position.y;
          const total = end - start;
          const gap = total / (nodes.length - 1);
          nodes.forEach((n, i) => dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: n.id, position: { x: n.position.x, y: start + (gap * i) } } }));
      }
      setContextMenu(null);
  };

  const handleCompact = (type: 'horizontal' | 'vertical') => { setContextMenu(null); }; 
  
  const handleNodeMove = useCallback((id: string, newPos: Position) => { dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: newPos } }); }, []);
  const handleNodeDragEnd = (id: string) => { setSnapLines([]); };
  const handleReset = async () => { 
      if (!confirm("Reset project?")) return;
      localStorage.removeItem('nodecode_project_local'); window.location.reload(); 
  };
  
  // Lock Handlers (Fixed)
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
          // Can I lock it? (Must be unlocked)
          if (isLocking) return !node.lockedBy; 
          // Can I unlock it? (Must be locked by me)
          return node.lockedBy?.uid === currentUser.uid;
      });
      
      if (validIds.length > 0) { 
          dispatchLocal({ type: 'LOCK_NODES', payload: { ids: validIds, user: isLocking ? currentUser : undefined } }); 
      }
      setContextMenu(null);
  };

  const handleForceUnlock = (nodeId: string) => {
      if (!confirm("Force unlock this node? This will remove the lock for everyone.")) return;
      dispatchLocal({ type: 'LOCK_NODES', payload: { ids: [nodeId], user: undefined } });
      setContextMenu(null);
  };

  const handleClearImage = (id: string) => { dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content: '' } }); };
  const handleAddNode = (type: NodeType) => { 
      if(!contextMenu) return; 
      const rect = containerRef.current?.getBoundingClientRect(); if(!rect) return;
      const x = (contextMenu.x - rect.left - state.pan.x) / state.zoom;
      const y = (contextMenu.y - rect.top - state.pan.y) / state.zoom;
      const d = NODE_DEFAULTS[type];
      dispatchLocal({ type: 'ADD_NODE', payload: { id: `node-${Date.now()}`, type, title: d.title, content: d.content, position: {x, y}, size: {width: d.width, height: d.height}, autoHeight: type==='CODE'?false:undefined } });
      setContextMenu(null);
  };
  
  // Find Nearest Logic (Fixed to go to node, not 0,0)
  const handleFindNearest = () => {
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    
    // Calculate world center
    const worldCenterX = (viewportCenterX - state.pan.x) / state.zoom;
    const worldCenterY = (viewportCenterY - state.pan.y) / state.zoom;
    
    let nearestNode: NodeData | null = null;
    let minDist = Infinity;
    
    // Find closest node to current center
    displayNodes.forEach(n => {
        const nW = n.size.width;
        const nH = n.isMinimized ? 40 : n.size.height;
        const nCenterX = n.position.x + nW / 2;
        const nCenterY = n.position.y + nH / 2;
        
        const dist = Math.hypot(nCenterX - worldCenterX, nCenterY - worldCenterY);
        if (dist < minDist) { minDist = dist; nearestNode = n; }
    });

    if (nearestNode) {
        const target = nearestNode as NodeData;
        setHighlightedNodeId(target.id);
        setTimeout(() => setHighlightedNodeId(null), 2000);

        const nW = target.size.width;
        const nH = target.isMinimized ? 40 : target.size.height;
        const targetCenterX = target.position.x + nW / 2;
        const targetCenterY = target.position.y + nH / 2;
        
        // Center the target in the viewport
        const newPanX = viewportCenterX - (targetCenterX * state.zoom);
        const newPanY = viewportCenterY - (targetCenterY * state.zoom);
        
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    }
  };
  
  const handleInjectImport = (srcId: string, pkg: string) => { /* NPM logic */ };
  const handleFixError = (id: string, err: string) => { /* AI Fix logic */ };

  // --- IMPLEMENTED HANDLERS ---
  const checkPermission = (nodeId: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return false;
      if (!node.lockedBy) return true;
      if (!currentUser) return false;
      return node.lockedBy.uid === currentUser.uid;
  };

  const isConnected = (portId: string) => {
      return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
  };

  const handleToggleRun = (id: string) => {
      const isRunning = state.runningPreviewIds.includes(id);
      dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: !isRunning } });
  };

  const handleRefresh = (id: string) => {
      const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
      if (iframe) {
          iframe.srcdoc = compilePreview(id, state.nodes, state.connections, true);
      }
  };

  const handleUpdateTitle = (id: string, title: string) => {
      if (checkPermission(id)) {
          dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title } });
      }
  };

  const handleStartContextSelection = (id: string) => {
      dispatchLocal({ 
          type: 'SET_SELECTION_MODE', 
          payload: { 
              isActive: true, 
              requestingNodeId: id, 
              selectedIds: state.nodes.find(n => n.id === id)?.contextNodeIds || [] 
          } 
      });
      setIsSidebarOpen(true);
  };

  const handleToggleSelectNode = (id: string, multi: boolean) => {
      if (state.selectionMode?.isActive) {
          const currentSelected = state.selectionMode.selectedIds;
          const newSelected = currentSelected.includes(id)
              ? currentSelected.filter(sid => sid !== id)
              : [...currentSelected, id];
          dispatchLocal({ 
              type: 'SET_SELECTION_MODE', 
              payload: { ...state.selectionMode, selectedIds: newSelected } 
          });
          return;
      }
      
      let newSelectedIds = multi ? [...state.selectedNodeIds] : [id];
      if (multi) {
          if (newSelectedIds.includes(id)) {
              newSelectedIds = newSelectedIds.filter(sid => sid !== id);
          } else {
              newSelectedIds.push(id);
          }
      }
      dispatchLocal({ type: 'SET_SELECTED_NODES', payload: newSelectedIds });
  };
  
  const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      
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
      e.preventDefault();
      e.stopPropagation();
      handleContextMenu(e, undefined, portId);
  };

  const handleBgPointerDown = (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).id !== 'canvas-bg') return;
      e.currentTarget.setPointerCapture(e.pointerId);
      
      // Fix: Check for Ctrl/Meta/Shift for Selection Box
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
             const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
             const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
             setSelectionBox({ x, y, w: 0, h: 0, startX: x, startY: y });
          }
      } else {
          setIsPanning(true);
          dragStartRef.current = { x: e.clientX, y: e.clientY };
          
          if (!state.selectionMode?.isActive) {
              dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [] });
          }
      }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
      if (isPanning && dragStartRef.current && !selectionBox) {
          const dx = e.clientX - dragStartRef.current.x;
          const dy = e.clientY - dragStartRef.current.y;
          dispatch({ type: 'PAN', payload: { x: state.pan.x + dx, y: state.pan.y + dy } });
          dragStartRef.current = { x: e.clientX, y: e.clientY };
      }

      if (dragWire) {
           const rect = containerRef.current?.getBoundingClientRect();
           if (rect) {
               const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
               const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
               setDragWire({ ...dragWire, x2: x, y2: y });
           }
      }

      if (selectionBox && containerRef.current) {
           const rect = containerRef.current.getBoundingClientRect();
           const currentX = (e.clientX - rect.left - state.pan.x) / state.zoom;
           const currentY = (e.clientY - rect.top - state.pan.y) / state.zoom;
           
           const x = Math.min(selectionBox.startX, currentX);
           const y = Math.min(selectionBox.startY, currentY);
           const w = Math.abs(currentX - selectionBox.startX);
           const h = Math.abs(currentY - selectionBox.startY);
           
           setSelectionBox({ ...selectionBox, x, y, w, h });
      }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      setIsPanning(false);
      dragStartRef.current = null;

      if (selectionBox) {
          const selected = state.nodes.filter(n => 
              n.position.x >= selectionBox.x && 
              n.position.x + n.size.width <= selectionBox.x + selectionBox.w &&
              n.position.y >= selectionBox.y && 
              n.position.y + n.size.height <= selectionBox.y + selectionBox.h
          ).map(n => n.id);
          
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: selected });
          setSelectionBox(null);
      }

      if (dragWire) {
          const elements = document.elementsFromPoint(e.clientX, e.clientY);
          const portEl = elements.find(el => el.hasAttribute('data-port-id'));
          
          if (portEl) {
              const targetPortId = portEl.getAttribute('data-port-id');
              const targetNodeId = portEl.getAttribute('data-node-id');
              
              if (targetPortId && targetNodeId && targetNodeId !== dragWire.startNodeId) {
                   dispatchLocal({
                      type: 'CONNECT',
                      payload: {
                          id: `conn-${Date.now()}`,
                          sourceNodeId: dragWire.isInput ? targetNodeId : dragWire.startNodeId,
                          sourcePortId: dragWire.isInput ? targetPortId : dragWire.startPortId,
                          targetNodeId: dragWire.isInput ? dragWire.startNodeId : targetNodeId,
                          targetPortId: dragWire.isInput ? dragWire.startPortId : targetPortId
                      }
                  });
              }
          }
          setDragWire(null);
      }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
          isPinching.current = true;
          const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
          );
          lastTouchDist.current = dist;
          touchStartPos.current = {
              x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
              y: (e.touches[0].clientY + e.touches[1].clientY) / 2
          };
      }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
      if (isPinching.current && e.touches.length === 2 && lastTouchDist.current && touchStartPos.current) {
          const dist = Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY
          );
          const center = {
              x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
              y: (e.touches[0].clientY + e.touches[1].clientY) / 2
          };

          const deltaZoom = dist / lastTouchDist.current;
          const newZoom = Math.min(Math.max(0.1, state.zoom * deltaZoom), 5);
          
          const dx = center.x - touchStartPos.current.x;
          const dy = center.y - touchStartPos.current.y;

          dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
          dispatch({ type: 'PAN', payload: { x: state.pan.x + dx, y: state.pan.y + dy } });

          lastTouchDist.current = dist;
          touchStartPos.current = center;
      }
  };

  const handleTouchEnd = () => {
      isPinching.current = false;
      lastTouchDist.current = null;
      touchStartPos.current = null;
  };

  // AI Wrappers
  const handleSendMessageWrapper = async (nodeId: string, text: string) => { await handleAiMessage(nodeId, text, { state, dispatch: dispatchLocal, checkPermission, onHighlight: (id) => setHighlightedNodeId(id) }); };
  const handleAiGenerateWrapper = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => { await handleAiGeneration(nodeId, action, promptText, { state, dispatch: dispatchLocal, checkPermission, onHighlight: (id) => setHighlightedNodeId(id) }); };
  const handleCancelAi = (id: string) => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id, isLoading: false } });

  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={`absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3 transition-opacity duration-200 ${maximizedNodeId ? 'opacity-0' : 'opacity-100'}`}>
        <div className="pointer-events-auto">
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">Coding Arena</h1>
            <p className="text-xs font-medium text-zinc-500">Local Session</p>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/80 border border-zinc-800 rounded-full backdrop-blur-sm pointer-events-auto">
            <Cloud size={14} className="text-emerald-500" />
            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400">Live</span>
        </div>
      </div>

      <div className={`absolute top-4 right-4 z-50 flex flex-col gap-2 items-end transition-opacity duration-200 ${maximizedNodeId ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
        <button onClick={handleReset} className="px-3 py-1.5 bg-red-900/80 hover:bg-red-800 text-xs font-medium text-red-100 border border-red-700 rounded flex items-center gap-2 pointer-events-auto cursor-pointer shadow-lg">
            <AlertTriangle size={12} /> Reset
        </button>
        <button onClick={() => setIsSidebarOpen(true)} className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center justify-center pointer-events-auto cursor-pointer">
            <Menu size={16} />
        </button>
        <button onClick={handleDownloadZip} className="px-3 py-2 bg-zinc-900/80 hover:bg-blue-600/50 text-xs text-zinc-400 hover:text-white border border-zinc-800 rounded flex items-center justify-center pointer-events-auto cursor-pointer">
            <Download size={16} />
        </button>
        <button onClick={handleFindNearest} className="px-3 py-2 bg-zinc-900/80 hover:bg-emerald-600/50 text-xs text-zinc-400 hover:text-white border border-zinc-800 rounded flex items-center justify-center pointer-events-auto cursor-pointer">
            <Search size={16} />
        </button>
      </div>

      <Sidebar 
        isOpen={isSidebarOpen} 
        nodes={state.nodes} 
        onNodeClick={(id) => { setHighlightedNodeId(id); setTimeout(() => setHighlightedNodeId(null), 2000); }} 
        onClose={() => setIsSidebarOpen(false)}
        selectionMode={state.selectionMode?.isActive ? { isActive: true, selectedIds: state.selectionMode.selectedIds, onToggle: (id) => handleToggleSelectNode(id, true), onConfirm: () => setIsSidebarOpen(false) } : undefined}
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
        {selectionBox && (
            <div 
                className="absolute bg-blue-500/10 border border-blue-500 z-[999]"
                style={{ left: selectionBox.x, top: selectionBox.y, width: selectionBox.w, height: selectionBox.h, pointerEvents: 'none' }}
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

                {displayNodes.map(node => {
                    let logs: LogEntry[] = [];
                    let folderContents: string[] = [];
                    if (node.type === 'TERMINAL') {
                         const sources = state.connections.filter(c => c.targetNodeId === node.id).map(c => c.sourceNodeId);
                         logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                    }
                    if (node.type === 'FOLDER') {
                        folderContents = state.connections.filter(c => c.targetNodeId === node.id && c.targetPortId.includes('in-files')).map(c => state.nodes.find(n => n.id === c.sourceNodeId)?.title).filter((t): t is string => !!t);
                    }
                    
                    return (
                        <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                            <Node
                                data={node}
                                isSelected={state.selectedNodeIds.includes(node.id)}
                                isHighlighted={node.id === highlightedNodeId}
                                isRunning={state.runningPreviewIds.includes(node.id)}
                                isMaximized={maximizedNodeId === node.id}
                                scale={state.zoom}
                                pan={state.pan}
                                isConnected={isConnected}
                                onMove={handleNodeMove}
                                onDragEnd={handleNodeDragEnd}
                                onResize={(id, size) => dispatchLocal({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                onDelete={(id) => checkPermission(id) && dispatchLocal({ type: 'DELETE_NODE', payload: id })}
                                onToggleRun={handleToggleRun}
                                onRefresh={handleRefresh}
                                onPortDown={handlePortDown}
                                onPortContextMenu={handlePortContextMenu}
                                onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}
                                onUpdateTitle={handleUpdateTitle}
                                onUpdateContent={(id, content) => checkPermission(id) && dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content } })}
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
                            />
                        </div>
                    );
                })}
                {dragWire && <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none" style={{ zIndex: 999 }}><Wire x1={dragWire.x1} y1={dragWire.y1} x2={dragWire.x2} y2={dragWire.y2} active /></svg>}
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
                selectedNodeIds={state.selectedNodeIds}
                onAdd={handleAddNode} 
                onDeleteNode={(id) => { checkPermission(id) && dispatchLocal({ type: 'DELETE_NODE', payload: id }); setContextMenu(null); }}
                onDuplicateNode={(id) => { /* dup logic */ setContextMenu(null); }}
                onDisconnect={(id) => { if (contextMenu.targetPortId) { dispatchLocal({ type: 'DISCONNECT', payload: id }); setContextMenu(null); } }}
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
