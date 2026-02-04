
import React, { useReducer, useState, useRef, useEffect, useMemo } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { GraphState, Action, NodeData, NodeType, LogEntry, UserPresence } from './types';
import { NODE_DEFAULTS, getPortsForNode } from './constants';
import { compilePreview, calculatePortPosition, getRelatedNodes, getAllConnectedSources, getConnectedSource } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, UploadCloud, Users } from 'lucide-react';
import Prism from 'prismjs';
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { signIn, db } from './firebase';
import { doc, getDoc, setDoc, onSnapshot, collection, deleteDoc, QuerySnapshot, DocumentData } from 'firebase/firestore';

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
        runningPreviewIds: state.runningPreviewIds.filter(id => id !== action.payload)
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
    case 'TOGGLE_PREVIEW':
        const { nodeId, isRunning } = action.payload;
        return {
            ...state,
            runningPreviewIds: isRunning 
                ? [...state.runningPreviewIds, nodeId] 
                : state.runningPreviewIds.filter(id => id !== nodeId)
        };
    case 'LOAD_STATE':
        const incomingNodes = action.payload.nodes || [];
        
        const mergedNodes = incomingNodes.map(serverNode => {
            const localNode = state.nodes.find(n => n.id === serverNode.id);
            const interactionType = state.nodeInteractions[serverNode.id];

            if (localNode) {
                if (interactionType === 'drag') {
                    return { ...serverNode, position: localNode.position };
                }
                if (interactionType === 'edit') {
                    return { ...serverNode, content: localNode.content, title: localNode.title };
                }
            }
            return serverNode;
        });

        return { 
          ...state, 
          nodes: mergedNodes, 
          connections: action.payload.connections || state.connections,
          runningPreviewIds: action.payload.runningPreviewIds || state.runningPreviewIds,
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
    default:
      return state;
  }
}

// ... (Gemini Tool Definitions and Helper Functions - No changes needed here) ...
// (Omitting strictly for brevity in this response, assuming standard merging)
const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Update the code content of a specific file. Use this for CHAT responses or simple edits.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the file to update.' },
            code: { type: Type.STRING, description: 'The NEW full content of the file.' }
        },
        required: ['filename', 'code']
    }
};

const updateCurrentFileTool: FunctionDeclaration = {
    name: 'updateCurrentFile',
    description: 'Update the content of the CURRENT file you are prompting from. Use this when the user says "fix this" or "change this".',
    parameters: {
        type: Type.OBJECT,
        properties: {
            code: { type: Type.STRING, description: 'The new full code content.' }
        },
        required: ['code']
    }
};

const createFileTool: FunctionDeclaration = {
    name: 'createFile',
    description: 'Create a new code file (node) on the canvas. Use this when you need to add HTML, CSS, or JS files to build a feature.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'Name of the file (e.g., style.css, app.js)' },
            content: { type: Type.STRING, description: 'Full code content of the file' }
        },
        required: ['filename', 'content']
    }
};

const connectNodesTool: FunctionDeclaration = {
    name: 'connectNodes',
    description: 'Connect two nodes by their titles. Use this to wire HTML to Preview, or CSS/JS to HTML.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            sourceTitle: { type: Type.STRING, description: 'Title of the source node (e.g. style.css)' },
            targetTitle: { type: Type.STRING, description: 'Title of the target node (e.g. index.html or Preview Output)' }
        },
        required: ['sourceTitle', 'targetTitle']
    }
};


type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

const getRandomColor = () => {
    const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'];
    return colors[Math.floor(Math.random() * colors.length)];
};

const cleanAiOutput = (text: string): string => {
    const codeBlockRegex = /```(?:html|css|js|javascript|json|typescript|ts)?\s*([\s\S]*?)```/i;
    const match = text.match(codeBlockRegex);
    if (match && match[1]) {
        return match[1].trim();
    }
    return text.trim();
};

// --- Helper: Find Non-Overlapping Position (Spiral Search) ---
const findSafePosition = (
    origin: { x: number, y: number }, 
    existingNodes: NodeData[], 
    width: number, 
    height: number
) => {
    let r = 50; // Start offset
    let angle = 0;
    
    // Safety break after ~100 attempts
    for (let i = 0; i < 100; i++) {
        const x = origin.x + r * Math.cos(angle);
        const y = origin.y + r * Math.sin(angle);
        
        // Check collision with all existing nodes
        // Using a 20px padding
        const collision = existingNodes.some(n => 
            x < n.position.x + n.size.width + 30 &&
            x + width + 30 > n.position.x &&
            y < n.position.y + n.size.height + 30 &&
            y + height + 30 > n.position.y
        );

        if (!collision) return { x, y };
        
        // Spiral out
        angle += 1; // ~57 degrees
        r += 10;
    }
    
    // Fallback
    return { x: origin.x + 50, y: origin.y + 50 };
};


export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
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
  const lastSentStateRef = useRef<Record<string, any>>({});

  // Long Press Logic for Mobile
  const longPressTimer = useRef<any>(null);
  const touchStartPos = useRef<{ x: number, y: number } | null>(null);

  // Cancellation & Request Tracking
  const activeAiOperations = useRef<Record<string, { id: string }>>({});

  const dispatchLocal = (action: Action) => {
      // Mark these actions as needing a sync save
      if ([
          'ADD_NODE', 
          'DELETE_NODE', 
          'UPDATE_NODE_POSITION', 
          'UPDATE_NODE_SIZE', 
          'UPDATE_NODE_CONTENT', 
          'UPDATE_NODE_TITLE', 
          'UPDATE_NODE_TYPE',
          'CONNECT', 
          'DISCONNECT',
          'TOGGLE_PREVIEW',
          'SET_NODE_LOADING',
          'UPDATE_NODE_SHARED_STATE' 
      ].includes(action.type)) {
          isLocalChange.current = true;
      }
      dispatch(action);
  };

  useEffect(() => {
    const init = async () => {
      try {
        setSyncStatus('saving'); 
        const user = await signIn();
        setUserUid(user.uid);
        
        const docRef = doc(db, 'nodecode_projects', 'global_project_room'); 
        
        const unsubscribeProject = onSnapshot(docRef, (docSnap) => {
             if (docSnap.metadata.hasPendingWrites) return;

             if (docSnap.exists()) {
                const data = docSnap.data() as { state: string } | undefined;
                if (data && data.state) {
                    const loadedState = JSON.parse(data.state);
                    dispatch({ 
                        type: 'LOAD_STATE', 
                        payload: { 
                            nodes: loadedState.nodes, 
                            connections: loadedState.connections,
                            runningPreviewIds: loadedState.runningPreviewIds
                        } 
                    });
                }
             } else {
                 const codeDefaults = NODE_DEFAULTS.CODE;
                 const previewDefaults = NODE_DEFAULTS.PREVIEW;
                 const defaultNodes: NodeData[] = [
                    { id: 'node-1', type: 'CODE', position: { x: 100, y: 100 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'index.html', content: '<h1>Hello World</h1>\n<link href="style.css" rel="stylesheet">\n<script src="app.js"></script>', autoHeight: true },
                    { id: 'node-2', type: 'CODE', position: { x: 100, y: 450 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'style.css', content: 'body { background: #222; color: #fff; font-family: sans-serif; }', autoHeight: true },
                    { id: 'node-3', type: 'PREVIEW', position: { x: 600, y: 100 }, size: { width: previewDefaults.width, height: previewDefaults.height }, title: previewDefaults.title, content: previewDefaults.content }
                 ];
                 const defaultState = {
                    nodes: defaultNodes,
                    connections: [],
                    pan: { x: 0, y: 0 },
                    zoom: 1
                 };
                 setDoc(docRef, { 
                     state: JSON.stringify(defaultState),
                     updatedAt: new Date().toISOString()
                 });
                 dispatch({ type: 'LOAD_STATE', payload: defaultState });
             }
             setSyncStatus('synced');
        }, (error) => {
            console.error("Project sync error:", error);
            setSyncStatus('error');
        });

        // ... (Presence logic omitted for brevity, identical to previous) ...
        const presenceRef = collection(db, 'nodecode_projects', 'global_project_room', 'presence');
        const unsubscribePresence = onSnapshot(presenceRef, (snapshot: QuerySnapshot<DocumentData>) => {
            const activeUsers: UserPresence[] = [];
            const now = Date.now();
            snapshot.forEach(doc => {
                const data = doc.data() as UserPresence;
                if (data.id !== sessionId && (now - data.lastActive < 30000)) { 
                    activeUsers.push(data);
                }
            });
            dispatch({ type: 'UPDATE_COLLABORATORS', payload: activeUsers });
        });

        return () => {
            unsubscribeProject();
            unsubscribePresence();
            deleteDoc(doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId));
        };

      } catch (err) {
        console.error("Failed to connect", err);
        setSyncStatus('error');
      }
    };

    init();
  }, [sessionId]);

  // ... (Save Logic, Live Update, Handle Message, etc. - Identical) ...
  // 2. Debounced Save - Only runs if isLocalChange is true
  useEffect(() => {
    if (!userUid) return;
    
    if (isLocalChange.current) {
        setSyncStatus('saving');
        const saveData = setTimeout(async () => {
          try {
             const docRef = doc(db, 'nodecode_projects', 'global_project_room');
             const stateToSave = {
                nodes: state.nodes, 
                connections: state.connections,
                runningPreviewIds: state.runningPreviewIds,
                pan: {x:0, y:0}, 
                zoom: 1
             };
             await setDoc(docRef, { 
                 state: JSON.stringify(stateToSave),
                 updatedAt: new Date().toISOString()
             });
             setSyncStatus('synced');
             isLocalChange.current = false; 
          } catch (e) {
              console.error("Save failed", e);
              setSyncStatus('error');
          }
        }, 800); 

        return () => clearTimeout(saveData);
    }
  }, [state.nodes, state.connections, state.runningPreviewIds, userUid]); 

  // LIVE UPDATE LOOP & SHARED STATE SYNC & STOP SYNC
  useEffect(() => {
      // 1. Handle Running Previews
      state.runningPreviewIds.forEach(previewId => {
          const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
          const node = state.nodes.find(n => n.id === previewId);

          if (iframe && node) {
               // Compile Code Update
               const compiled = compilePreview(previewId, state.nodes, state.connections, false);
               if (iframe.srcdoc !== compiled) {
                  iframe.srcdoc = compiled;
               }

               // Sync Shared State
               const lastSent = lastSentStateRef.current[previewId];
               if (JSON.stringify(node.sharedState) !== JSON.stringify(lastSent)) {
                   if (iframe.contentWindow) {
                       iframe.contentWindow.postMessage({
                           type: 'STATE_UPDATE',
                           payload: node.sharedState
                       }, '*');
                       lastSentStateRef.current[previewId] = node.sharedState;
                   }
               }
          }
      });

      // 2. Handle Stopped Previews (Fix desync)
      const previewNodes = state.nodes.filter(n => n.type === 'PREVIEW');
      previewNodes.forEach(node => {
          if (!state.runningPreviewIds.includes(node.id)) {
              const iframe = document.getElementById(`preview-iframe-${node.id}`) as HTMLIFrameElement;
              const stoppedContent = '<body style="background-color: #000; color: #555; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; font-family: sans-serif;">STOPPED</body>';
              
              if (iframe && iframe.srcdoc !== stoppedContent) {
                  iframe.srcdoc = stoppedContent;
              }
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
        } else if (data.type === 'BROADCAST_STATE') {
            lastSentStateRef.current[data.nodeId] = data.payload;
            dispatchLocal({ type: 'UPDATE_NODE_SHARED_STATE', payload: { nodeId: data.nodeId, state: data.payload } });
        } else if (data.type === 'IFRAME_READY') {
            const node = state.nodes.find(n => n.id === data.nodeId);
            if (node && node.sharedState) {
                const iframe = document.getElementById(`preview-iframe-${data.nodeId}`) as HTMLIFrameElement;
                if (iframe?.contentWindow) {
                    iframe.contentWindow.postMessage({
                        type: 'STATE_UPDATE',
                        payload: node.sharedState
                    }, '*');
                    lastSentStateRef.current[data.nodeId] = node.sharedState;
                }
            }
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [state.nodes]);

  const handleUpdateTitle = (id: string, newTitle: string) => {
      const node = state.nodes.find(n => n.id === id);
      if (!node) return;

      const ext = newTitle.split('.').pop()?.toLowerCase();
      
      const codeExts = ['html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'css', 'json', 'txt', 'md'];
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'];

      let newType = node.type;

      if (codeExts.includes(ext || '')) {
          newType = 'CODE';
      } else if (imageExts.includes(ext || '')) {
          newType = 'IMAGE';
      } else if (node.type === 'IMAGE' || node.type === 'CODE') {
          // If extension exists but is invalid for these types, reject the rename
          if (newTitle.includes('.') && !codeExts.includes(ext || '') && !imageExts.includes(ext || '')) {
               alert(`.${ext} is not a supported file type for this module.`);
               return; 
          }
      }

      dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id, title: newTitle } });
      if (newType !== node.type) {
          dispatchLocal({ type: 'UPDATE_NODE_TYPE', payload: { id, type: newType } });
      }
  };

  // ... (Other Handlers remain similar but using dispatchLocal) ...
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

  const handleWheel = (e: React.WheelEvent) => {
    if ((e.target as HTMLElement).closest('.custom-scrollbar') || (e.target as HTMLElement).closest('.monaco-editor')) return;
    
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const worldX = (mouseX - state.pan.x) / state.zoom;
    const worldY = (mouseY - state.pan.y) / state.zoom;

    const zoomIntensity = 0.001;
    const newZoom = Math.min(Math.max(0.1, state.zoom - e.deltaY * zoomIntensity), 3);

    const newPanX = mouseX - worldX * newZoom;
    const newPanY = mouseY - worldY * newZoom;

    if (!isNaN(newZoom) && !isNaN(newPanX) && !isNaN(newPanY)) {
        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
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
      autoHeight: type === 'CODE' ? true : undefined, 
    };
    dispatchLocal({ type: 'ADD_NODE', payload: newNode });
    setContextMenu(null);
  };

  const handleClearImage = (id: string) => {
      dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content: '' } });
      setContextMenu(null);
  };

  const handleHighlightNode = (id: string) => {
      setHighlightedNodeId(id);
      setTimeout(() => {
          setHighlightedNodeId(null);
      }, 2000);
  };

  const handleToggleRun = (id: string) => {
      const isRunning = state.runningPreviewIds.includes(id);
      const shouldRun = !isRunning;
      const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
      
      if (shouldRun) {
           dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: true } });
           dispatch({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
      } else {
           dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: false } });
           dispatch({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
           if (iframe) {
               iframe.srcdoc = '<body style="background-color: #000; color: #555; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; font-family: sans-serif;">STOPPED</body>';
           }
      }
  };

  const handleRefresh = (id: string) => {
     const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
     if (iframe) {
          const compiled = compilePreview(id, state.nodes, state.connections, true);
          iframe.srcdoc = compiled;
     }
  };

  const handleInjectImport = (sourceNodeId: string, packageName: string) => {
      const connections = state.connections.filter(c => c.sourceNodeId === sourceNodeId);
      let injectedCount = 0;
      connections.forEach(conn => {
          const targetNode = state.nodes.find(n => n.id === conn.targetNodeId);
          if (targetNode && targetNode.type === 'CODE') {
              const importStatement = `import * as ${packageName.replace(/[^a-zA-Z0-9]/g, '_')} from 'https://esm.sh/${packageName}';\n`;
              if (!targetNode.content.includes(`https://esm.sh/${packageName}`)) {
                  dispatchLocal({ 
                      type: 'UPDATE_NODE_CONTENT', 
                      payload: { 
                          id: targetNode.id, 
                          content: importStatement + targetNode.content 
                      } 
                  });
                  injectedCount++;
                  handleHighlightNode(targetNode.id);
              }
          }
      });
      if (injectedCount === 0) {
          alert('Connect this NPM node to a Code node first!');
      }
  };

  const handleStartContextSelection = (nodeId: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      dispatch({ 
          type: 'SET_SELECTION_MODE', 
          payload: { 
              isActive: true, 
              requestingNodeId: nodeId, 
              selectedIds: node?.contextNodeIds || [] 
          } 
      });
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
      dispatchLocal({ 
          type: 'UPDATE_CONTEXT_NODES', 
          payload: { 
              id: state.selectionMode.requestingNodeId, 
              nodeIds: state.selectionMode.selectedIds 
          } 
      });
      dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: false } });
  };

  const handleCancelAi = (nodeId: string) => {
      if (activeAiOperations.current[nodeId]) {
          delete activeAiOperations.current[nodeId];
      }
      dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
      dispatch({ 
          type: 'ADD_MESSAGE', 
          payload: { id: nodeId, message: { role: 'model', text: '[Processing stopped by user]' } } 
      });
  };

  const handleSendMessage = async (nodeId: string, text: string) => {
      dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
      dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } }); 

      const opId = `chat-${Date.now()}`;
      activeAiOperations.current[nodeId] = { id: opId };

      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;

      const contextFiles = (node.contextNodeIds || [])
          .map(id => state.nodes.find(n => n.id === id))
          .filter(n => n && n.type === 'CODE');

      const fileContext = contextFiles.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');

      const systemInstruction = `You are an expert coding assistant in NodeCode Studio. 
      You are concise in conversation but thorough in coding.
      
      CRITICAL RULE:
      When asked to write or update code, you must ONLY use the 'updateFile' tool.
      Do NOT write code blocks in the chat response.
      Do NOT provide conversational filler like "Here is the code".
      Just call the tool.
      
      Current Context Files:
      ${contextFiles.length > 0 ? contextFiles.map(f => f?.title).join(', ') : 'No files selected.'}`;

      try {
          const apiKey = process.env.API_KEY; 
          if (!apiKey) throw new Error('API Key not found.');

          const ai = new GoogleGenAI({ apiKey });
          const fullPrompt = `User Query: ${text}\n\nContext Files Content:\n${fileContext}`;

          dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });

          const resultPromise = ai.models.generateContentStream({
              model: 'gemini-flash-lite-latest',
              contents: fullPrompt,
              config: {
                  systemInstruction,
                  tools: [{ functionDeclarations: [updateCodeFunction] }]
              }
          });

          const timeoutPromise = new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error("Timeout: AI took too long to respond.")), 90000)
          );

          const result = await Promise.race([resultPromise, timeoutPromise]);

          let fullText = '';
          const functionCalls: any[] = [];

          for await (const chunk of result) {
              if (activeAiOperations.current[nodeId]?.id !== opId) {
                  throw new Error("Cancelled");
              }

              if (chunk.text) {
                  fullText += chunk.text;
                  dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
              }
              if (chunk.functionCalls) {
                  functionCalls.push(...chunk.functionCalls);
              }
          }

          let toolOutputText = '';
          if (functionCalls.length > 0) {
              for (const call of functionCalls) {
                  if (activeAiOperations.current[nodeId]?.id !== opId) break;

                  if (call.name === 'updateFile') {
                      const args = call.args as { filename: string, code: string };
                      const targetNode = state.nodes.find(n => n.type === 'CODE' && n.title === args.filename);
                      
                      if (targetNode) {
                          dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: targetNode.id, content: args.code } });
                          toolOutputText += `\n[Updated ${args.filename}]`;
                          handleHighlightNode(targetNode.id);
                      } else {
                          toolOutputText += `\n[Error: Could not find file ${args.filename}]`;
                      }
                  }
              }
              if (toolOutputText) {
                  fullText += toolOutputText;
                  dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
              }
          }

      } catch (error: any) {
          if (error.message === "Cancelled") return; // Silent exit

          let errorMessage = error.message;
          if (error.message.includes('429')) errorMessage = "Rate Limit Exceeded. Please try again later.";
          
          dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${errorMessage}` } } });
      } finally {
          if (activeAiOperations.current[nodeId]?.id === opId) {
              dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } }); 
              delete activeAiOperations.current[nodeId];
          }
      }
  };

  const handleFixError = async (terminalNodeId: string, errorText: string) => {
      const previewNode = getConnectedSource(terminalNodeId, 'logs', state.nodes, state.connections);
      if (!previewNode) {
          alert("This terminal isn't connected to a Preview.");
          return;
      }
      const connectedCodeNodes = getAllConnectedSources(previewNode.id, 'dom', state.nodes, state.connections);
      if (connectedCodeNodes.length === 0) {
          alert("No code connected to the preview to fix.");
          return;
      }
      const anchorNode = connectedCodeNodes[0];
      const prompt = `Fix the following runtime error: "${errorText}". \n\nReview the connected code files and apply the necessary fix using 'updateFile'.`;
      handleAiGenerate(anchorNode.id, 'prompt', prompt);
  };

  const handleAiGenerate = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node || node.type !== 'CODE') return;
      
      const connectedCodeNodes = getRelatedNodes(nodeId, state.nodes, state.connections, 'CODE');
      if (!connectedCodeNodes.find(n => n.id === nodeId)) connectedCodeNodes.push(node);

      const opId = `gen-${Date.now()}`;
      connectedCodeNodes.forEach(n => {
          activeAiOperations.current[n.id] = { id: opId };
          dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: true } });
      });

      try {
          const apiKey = process.env.API_KEY; 
          const ai = new GoogleGenAI({ apiKey });
          
          let systemInstruction = '';
          let userPrompt = '';
          let tools: FunctionDeclaration[] = [];

          if (action === 'optimize') {
              systemInstruction = `You are an expert developer.
              CRITICAL: RETURN ONLY PURE CODE. NO MARKDOWN. NO BACKTICKS. NO CONVERSATIONAL TEXT.
              Just the raw code content string.`;
              userPrompt = `Optimize the following code (Remove dead code, keep logic):\n\n${node.content}`;
              
              const responsePromise = ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: userPrompt,
                  config: { systemInstruction }
              });

              const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 30000));
              const response = await Promise.race([responsePromise, timeoutPromise]);
              
              if (activeAiOperations.current[nodeId]?.id !== opId) throw new Error("Cancelled");

              if (response.text) {
                 const cleanCode = cleanAiOutput(response.text);
                 dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: cleanCode } });
              }

          } else {
              const projectContext = connectedCodeNodes.map(n => 
                  `Filename: "${n.title}"\nContent:\n${n.content}`
              ).join('\n\n----------------\n\n');

              systemInstruction = `You are an expert web developer and architect in NodeCode Studio.
              You have the ability to not just write code, but to BUILD THE GRAPH.
              
              You are viewing a cluster of connected files. You have access to:
              ${connectedCodeNodes.map(n => n.title).join(', ')}

              Capabilities:
              1. **updateFile(filename, code)**: Use this to update ANY file in the connected graph.
              2. **createFile(filename, content)**: Use this ONLY if the user asks for a completely NEW feature that requires a NEW file.
              3. **connectNodes(sourceTitle, targetTitle)**: Use this to wire files together. 
                 
              Guidelines:
              - Always write complete, working code.
              `;
              
              userPrompt = `Project Context:\n${projectContext}\n\nUser Request regarding "${node.title}": ${promptText}`;
              tools = [updateCodeFunction, createFileTool, connectNodesTool];

              const responsePromise = ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: userPrompt,
                  config: { 
                      systemInstruction,
                      tools: [{ functionDeclarations: tools }]
                  }
              });

              const timeoutPromise = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 120000));
              const response = await Promise.race([responsePromise, timeoutPromise]);

              if (activeAiOperations.current[nodeId]?.id !== opId) throw new Error("Cancelled");

              const functionCalls = response.functionCalls;
              const createdNodesMap = new Map<string, string>(); 
              state.nodes.forEach(n => createdNodesMap.set(n.title, n.id));

              if (functionCalls && functionCalls.length > 0) {
                  const creations = functionCalls.filter(c => c.name === 'createFile');
                  const updates = functionCalls.filter(c => c.name === 'updateFile');
                  const connections = functionCalls.filter(c => c.name === 'connectNodes');

                  updates.forEach(call => {
                       const args = call.args as { filename: string, code: string };
                       const targetNode = state.nodes.find(n => n.title === args.filename);
                       if (targetNode) {
                            dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: targetNode.id, content: args.code } });
                       }
                  });

                  creations.forEach(call => {
                      const args = call.args as { filename: string, content: string };
                      const defaults = NODE_DEFAULTS.CODE;
                      const newPos = findSafePosition(node.position, state.nodes, defaults.width, defaults.height);
                      const id = `node-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                      const newNode: NodeData = {
                          id, type: 'CODE', title: args.filename, content: args.content,
                          position: newPos, size: { width: defaults.width, height: defaults.height }, autoHeight: true // Default autoHeight for new nodes
                      };
                      createdNodesMap.set(args.filename, id);
                      state.nodes.push(newNode); 
                      dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                  });

                  connections.forEach(call => {
                      const args = call.args as { sourceTitle: string, targetTitle: string };
                      const sourceId = createdNodesMap.get(args.sourceTitle);
                      let targetId = createdNodesMap.get(args.targetTitle);

                      if (sourceId) {
                          if (!targetId) {
                              const existingTarget = state.nodes.find(n => n.title === args.targetTitle);
                              if (existingTarget) targetId = existingTarget.id;
                          }
                          // Generic Preview check
                          if (!targetId && args.targetTitle.toLowerCase().includes('preview')) {
                              const anyPreview = state.nodes.find(n => n.type === 'PREVIEW');
                              if (anyPreview) targetId = anyPreview.id;
                          }
                          
                          // Fix for JS/CSS -> Preview connection
                          if (targetId) {
                              const targetNode = state.nodes.find(n => n.id === targetId);
                              const isSourceScriptOrStyle = args.sourceTitle.endsWith('.js') || args.sourceTitle.endsWith('.css');
                              if (targetNode && targetNode.type === 'PREVIEW' && isSourceScriptOrStyle) {
                                  let htmlId = Array.from(createdNodesMap.entries()).find(([t]) => t.endsWith('.html'))?.[1];
                                  if (!htmlId) {
                                      htmlId = state.nodes.find(n => n.title.endsWith('.html'))?.id;
                                  }
                                  if (htmlId) targetId = htmlId;
                              }
                          }
                      }

                      if (sourceId && targetId) {
                          let sourcePort = 'out-dom'; 
                          let targetPort = 'in-file'; 
                          
                          if (args.sourceTitle.endsWith('.html')) sourcePort = 'out-dom';
                          if (args.sourceTitle.endsWith('.js') || args.sourceTitle.endsWith('.css')) sourcePort = 'out-dom'; 
                          
                          const targetNode = state.nodes.find(n => n.id === targetId);
                          if (targetNode) {
                              if (targetNode.type === 'PREVIEW') targetPort = 'in-dom';
                              else if (targetNode.type === 'CODE') targetPort = 'in-file';
                          }

                          dispatchLocal({
                              type: 'CONNECT',
                              payload: {
                                  id: `conn-${Date.now()}-${Math.random()}`,
                                  sourceNodeId: sourceId,
                                  sourcePortId: `${sourceId}-${sourcePort}`,
                                  targetNodeId: targetId,
                                  targetPortId: `${targetId}-${targetPort}`
                              }
                          });
                      }
                  });
              }
          }

      } catch(e: any) { 
          if (e.message !== "Cancelled") {
              console.error(e); 
              alert(e.message.includes('429') ? "Rate Limit Reached. Try again later." : "AI Processing Failed or Timed Out.");
          }
      } finally { 
          connectedCodeNodes.forEach(n => {
            if (activeAiOperations.current[n.id]?.id === opId) {
                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: false } }); 
                delete activeAiOperations.current[n.id];
            }
          });
      }
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
    if (isPinching.current) return;

    if (dragWire && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
        const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
        setDragWire(prev => prev ? { ...prev, x2: x, y2: y } : null);
    } 
    
    if (isPanning) {
        dispatch({ type: 'PAN', payload: { x: state.pan.x + e.movementX, y: state.pan.y + e.movementY } });
    }

    if (userUid && containerRef.current) {
        const now = Date.now();
        if (now - throttleRef.current > 60) { 
            throttleRef.current = now;
            const rect = containerRef.current.getBoundingClientRect();
            const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
            const y = (e.clientY - rect.top - state.pan.y) / state.zoom;

            const draggingNodeId = Object.keys(state.nodeInteractions).find(id => state.nodeInteractions[id] === 'drag');
            const draggingPosition = draggingNodeId ? state.nodes.find(n => n.id === draggingNodeId)?.position : undefined;
            const editingNodeId = Object.keys(state.nodeInteractions).find(id => state.nodeInteractions[id] === 'edit');

            setDoc(doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId), {
                id: sessionId,
                x,
                y,
                color: userColor,
                lastActive: now,
                draggingNodeId: draggingNodeId || null,
                draggingPosition: draggingPosition || null,
                editingNodeId: editingNodeId || null
            }, { merge: true });
        }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
        setIsPanning(false);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    }

    if (!dragWire) return;
    
    // Snapping Logic
    let targetPortId = null;
    let targetNodeId = null;
    let minDistance = 40; // Snapping radius (40px)

    if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left - state.pan.x) / state.zoom;
        const mouseY = (e.clientY - rect.top - state.pan.y) / state.zoom;

        const targetEl = document.elementFromPoint(e.clientX, e.clientY);
        const portEl = targetEl?.closest('[data-port-id]');
        if (portEl) {
            targetPortId = portEl.getAttribute('data-port-id');
            targetNodeId = portEl.getAttribute('data-node-id');
        } else {
            state.nodes.forEach(node => {
                if (node.id === dragWire.startNodeId) return;

                const ports = getPortsForNode(node.id, node.type);
                ports.forEach(port => {
                    const isTargetInput = port.type === 'input';
                    if (dragWire.isInput === isTargetInput) return;

                    const pos = calculatePortPosition(node, port.id, port.type);
                    const dist = Math.hypot(pos.x - mouseX, pos.y - mouseY);

                    if (dist < minDistance) {
                        minDistance = dist;
                        targetPortId = port.id;
                        targetNodeId = node.id;
                    }
                });
            });
        }
    }

    if (targetPortId && targetNodeId && targetPortId !== dragWire.startPortId) {
        const isStartInput = dragWire.isInput;
        const isTargetInput = targetPortId.includes('-in-');
        
        if (isStartInput !== isTargetInput && dragWire.startNodeId !== targetNodeId) {
            dispatchLocal({
                type: 'CONNECT',
                payload: {
                    id: `conn-${Date.now()}`,
                    sourceNodeId: isStartInput ? targetNodeId : dragWire.startNodeId,
                    sourcePortId: isStartInput ? targetPortId : dragWire.startPortId,
                    targetNodeId: isStartInput ? dragWire.startNodeId : targetNodeId,
                    targetPortId: isStartInput ? dragWire.startPortId : targetPortId
                }
            });
        }
    }

    setDragWire(null);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
          isPinching.current = true;
          setIsPanning(false); 
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchDist.current = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          
          if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
          }
          return;
      }

      if (e.touches.length === 1) {
          const touch = e.touches[0];
          const target = e.target as HTMLElement;
          
          const isNode = target.closest('[data-node-id]');
          const isPort = target.closest('[data-port-id]');
          
          if (!isNode && !isPort) {
              touchStartPos.current = { x: touch.clientX, y: touch.clientY };
              longPressTimer.current = setTimeout(() => {
                  setContextMenu({ 
                      x: touch.clientX, 
                      y: touch.clientY 
                  });
                  if (navigator.vibrate) navigator.vibrate(50);
                  longPressTimer.current = null;
              }, 800);
          }
      }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
      if (e.touches.length === 2 && lastTouchDist.current !== null && containerRef.current) {
          e.preventDefault(); 
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          
          if (dist > 0 && lastTouchDist.current > 0) {
              const scale = dist / lastTouchDist.current;
              const rect = containerRef.current.getBoundingClientRect();
              const centerX = (t1.clientX + t2.clientX) / 2 - rect.left;
              const centerY = (t1.clientY + t2.clientY) / 2 - rect.top;
              const worldX = (centerX - state.pan.x) / state.zoom;
              const worldY = (centerY - state.pan.y) / state.zoom;
              const newZoom = Math.min(Math.max(0.1, state.zoom * scale), 3);
              const newPanX = centerX - worldX * newZoom;
              const newPanY = centerY - worldY * newZoom;

              dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
              dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
          }
          lastTouchDist.current = dist;
      }

      if (longPressTimer.current && touchStartPos.current && e.touches.length === 1) {
          const touch = e.touches[0];
          const diffX = Math.abs(touch.clientX - touchStartPos.current.x);
          const diffY = Math.abs(touch.clientY - touchStartPos.current.y);
          if (diffX > 10 || diffY > 10) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
          }
      }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
      if (longPressTimer.current) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
      }
      touchStartPos.current = null;

      if (e.touches.length < 2) {
          isPinching.current = false;
          lastTouchDist.current = null;
      }
  };


  const isConnected = (portId: string) => {
      return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
  };

  const displayNodes = useMemo(() => {
    return state.nodes.map(node => {
        const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId);
        
        if (collaborator && collaborator.draggingPosition) {
            return { 
                ...node, 
                position: collaborator.draggingPosition,
                _remoteDrag: true 
            };
        }
        return node;
    });
  }, [state.nodes, state.collaborators, sessionId]);

  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3">
        <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">NodeCode Studio</h1>
            <p className="text-xs text-zinc-500">Global Collaborative Session</p>
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
        <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/80 border border-zinc-800 rounded-full backdrop-blur-sm">
             <Users size={14} className="text-indigo-400" />
             <span className="text-[10px] font-bold text-zinc-400">
                 {state.collaborators.length + 1} Online
             </span>
        </div>
      </div>

      <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 items-end">
        <button 
            onClick={() => { if(confirm('Reset?')) { localStorage.removeItem('nodecode-studio-v1'); window.location.reload(); } }}
            className="px-3 py-1.5 bg-zinc-900/80 hover:bg-red-900/50 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center gap-2 transition-colors pointer-events-auto cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <Trash2 size={12} /> Reset
        </button>
        <button 
            onClick={() => setIsSidebarOpen(true)}
            className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
        >
            <Menu size={16} />
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
        onWheel={handleWheel}
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
        <div 
            style={{ 
                transform: `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`,
                transformOrigin: '0 0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none'
            }}
        >
            <div className="pointer-events-none w-full h-full relative">
                {/* Collaborator Cursors Layer */}
                <div className="absolute inset-0 z-[999] pointer-events-none overflow-visible">
                    {state.collaborators.map(user => (
                        <CollaboratorCursor 
                            key={user.id} 
                            x={user.x} 
                            y={user.y} 
                            color={user.color} 
                            name={''} 
                        />
                    ))}
                </div>

                <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                    {state.connections.map(conn => {
                        const sourceNode = displayNodes.find(n => n.id === conn.sourceNodeId);
                        const targetNode = displayNodes.find(n => n.id === conn.targetNodeId);
                        if (!sourceNode || !targetNode) return null;
                        const start = calculatePortPosition(sourceNode, conn.sourcePortId, 'output');
                        const end = calculatePortPosition(targetNode, conn.targetPortId, 'input');
                        return <Wire key={conn.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />;
                    })}
                </svg>

                {displayNodes.map(node => {
                    let logs: LogEntry[] = [];
                    if (node.type === 'TERMINAL') {
                         const sources = state.connections.filter(c => c.targetNodeId === node.id).map(c => c.sourceNodeId);
                         logs = sources.flatMap(sid => state.logs[sid] || []).sort((a, b) => a.timestamp - b.timestamp);
                    }
                    
                    const activeCollaborator = state.collaborators.find(c => 
                        (c.draggingNodeId === node.id || c.editingNodeId === node.id) && c.id !== sessionId
                    );
                    const collabInfo = activeCollaborator ? {
                        name: '', 
                        color: activeCollaborator.color,
                        action: (activeCollaborator.editingNodeId === node.id ? 'editing' : 'dragging') as 'editing' | 'dragging'
                    } : undefined;

                    return (
                        <div key={node.id} onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }}>
                            <Node
                                data={node}
                                isSelected={false}
                                isHighlighted={node.id === highlightedNodeId}
                                isRunning={state.runningPreviewIds.includes(node.id)}
                                scale={state.zoom}
                                isConnected={isConnected}
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
                                onStartContextSelection={handleStartContextSelection}
                                onAiAction={handleAiGenerate}
                                onCancelAi={handleCancelAi}
                                onInjectImport={handleInjectImport}
                                onFixError={handleFixError}
                                onInteraction={(id, type) => dispatch({ type: 'SET_NODE_INTERACTION', payload: { nodeId: id, type } })}
                                collaboratorInfo={collabInfo}
                                logs={logs}
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
                        dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                    }
                    setContextMenu(null); 
                }}
                onDisconnect={(id) => { dispatchLocal({ type: 'DISCONNECT', payload: id }); setContextMenu(null); }}
                onClearImage={handleClearImage}
                onClose={() => setContextMenu(null)} 
            />
        </>
      )}
    </div>
  );
}
