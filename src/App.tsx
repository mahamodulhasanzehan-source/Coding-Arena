
import React, { useReducer, useState, useRef, useEffect, useMemo } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { GraphState, Action, NodeData, NodeType, LogEntry, UserPresence, Position } from './types';
import { NODE_DEFAULTS, getPortsForNode } from './constants';
import { compilePreview, calculatePortPosition, getRelatedNodes, getAllConnectedSources, getConnectedSource } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, UploadCloud, Users, Download, Search } from 'lucide-react';
import Prism from 'prismjs';
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { signIn, db } from './firebase';
import { doc, getDoc, setDoc, onSnapshot, collection, deleteDoc, QuerySnapshot, DocumentData } from 'firebase/firestore';
import JSZip from 'jszip';

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
    case 'TOGGLE_MINIMIZE':
        return {
            ...state,
            nodes: state.nodes.map(n => n.id === action.payload.id ? { ...n, isMinimized: !n.isMinimized } : n)
        };
    case 'SET_SELECTED_NODES':
        return { ...state, selectedNodeIds: action.payload };
    default:
      return state;
  }
}

// --- Gemini Tool Definition ---
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
    description: 'Create a new code file (node) on the canvas. Use this when the user explicitly asks to "create a file" or needs a new module.',
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

const findSafePosition = (
    origin: { x: number, y: number }, 
    existingNodes: NodeData[], 
    width: number, 
    height: number
) => {
    let r = 50; // Start offset
    let angle = 0;
    
    for (let i = 0; i < 100; i++) {
        const x = origin.x + r * Math.cos(angle);
        const y = origin.y + r * Math.sin(angle);
        
        const collision = existingNodes.some(n => 
            x < n.position.x + n.size.width + 30 &&
            x + width + 30 > n.position.x &&
            y < n.position.y + n.size.height + 30 &&
            y + height + 30 > n.position.y
        );

        if (!collision) return { x, y };
        
        angle += 1; // ~57 degrees
        r += 10;
    }
    
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
  const [snapLines, setSnapLines] = useState<{x1: number, y1: number, x2: number, y2: number}[]>([]);
  
  // Selection Box State
  const [selectionBox, setSelectionBox] = useState<{ x: number, y: number, w: number, h: number, startX: number, startY: number } | null>(null);

  const sessionId = useMemo(() => `session-${Math.random().toString(36).substr(2, 9)}`, []);
  const isLocalChange = useRef(false);
  const lastTouchDist = useRef<number | null>(null);
  const isPinching = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const throttleRef = useRef(0);
  const lastSentStateRef = useRef<Record<string, any>>({});

  const longPressTimer = useRef<any>(null);
  const touchStartPos = useRef<{ x: number, y: number } | null>(null);

  const activeAiOperations = useRef<Record<string, { id: string }>>({});

  const dispatchLocal = (action: Action) => {
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
          'UPDATE_NODE_SHARED_STATE',
          'TOGGLE_MINIMIZE',
          'SET_SELECTED_NODES'
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

  // LIVE UPDATE LOOP
  useEffect(() => {
      // 1. Handle Running Previews
      state.runningPreviewIds.forEach(previewId => {
          const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
          const node = state.nodes.find(n => n.id === previewId);

          if (iframe && node) {
               const compiled = compilePreview(previewId, state.nodes, state.connections, false);
               if (iframe.srcdoc !== compiled) {
                  iframe.srcdoc = compiled;
               }

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
              
              if (iframe && iframe.srcdoc && !iframe.srcdoc.includes("STOPPED")) {
                  // Only update if it doesn't already show stopped to avoid loop
                  // But handleToggleRun handles the initial setting.
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

  const handleDownloadZip = async () => {
    const zip = new JSZip();
    const codeNodes = state.nodes.filter(n => n.type === 'CODE');
    
    // Build adjacency list for CODE-to-CODE connections
    const adj = new Map<string, string[]>();
    codeNodes.forEach(n => adj.set(n.id, []));
    
    state.connections.forEach(c => {
        const source = state.nodes.find(n => n.id === c.sourceNodeId);
        const target = state.nodes.find(n => n.id === c.targetNodeId);
        if (source?.type === 'CODE' && target?.type === 'CODE') {
            adj.get(source.id)?.push(target.id);
            adj.get(target.id)?.push(source.id);
        }
    });

    const visited = new Set<string>();
    const clusters: NodeData[][] = [];

    // Find Connected Components
    for (const node of codeNodes) {
        if (!visited.has(node.id)) {
            const cluster: NodeData[] = [];
            const queue = [node.id];
            visited.add(node.id);
            
            while(queue.length) {
                const currId = queue.shift()!;
                const currNode = state.nodes.find(n => n.id === currId);
                if (currNode) cluster.push(currNode);
                
                const neighbors = adj.get(currId) || [];
                for (const nId of neighbors) {
                    if (!visited.has(nId)) {
                        visited.add(nId);
                        queue.push(nId);
                    }
                }
            }
            clusters.push(cluster);
        }
    }

    // Process clusters
    clusters.forEach(cluster => {
        if (cluster.length > 1) {
            // Wired: Create folder
            const folderName = `bundle-${Math.random().toString(36).substr(2, 6)}`;
            const folder = zip.folder(folderName);
            if (folder) {
                cluster.forEach(node => {
                    let filename = node.title;
                    let counter = 1;
                    // Check for collision in this folder (though unlikely in valid projects)
                    while(folder.file(filename)) {
                        const parts = node.title.split('.');
                        const ext = parts.length > 1 ? parts.pop() : '';
                        const base = parts.join('.');
                        filename = `${base} (${counter})${ext ? '.' + ext : ''}`;
                        counter++;
                    }
                    folder.file(filename, node.content);
                });
            }
        } else if (cluster.length === 1) {
            // Unwired (Single node)
            const node = cluster[0];
            let filename = node.title;
            let counter = 1;
            while(zip.file(filename)) {
                 const parts = node.title.split('.');
                 const ext = parts.length > 1 ? parts.pop() : '';
                 const base = parts.join('.');
                 filename = `${base} (${counter})${ext ? '.' + ext : ''}`;
                 counter++;
            }
            zip.file(filename, node.content);
        }
    });

    try {
        const content = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url;
        a.download = "nodecode-project.zip";
        a.click();
        window.URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Failed to generate zip", e);
        alert("Failed to create zip file.");
    }
  };

  const handleHighlightNode = (id: string) => {
      setHighlightedNodeId(id);
      setTimeout(() => {
          setHighlightedNodeId(null);
      }, 2000);
  };

  const handleFindNearest = () => {
      if (state.nodes.length === 0) return;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Current center in world coordinates
      const centerX = (viewportWidth / 2 - state.pan.x) / state.zoom;
      const centerY = (viewportHeight / 2 - state.pan.y) / state.zoom;

      let nearestId = null;
      let minDistance = Infinity;

      state.nodes.forEach(node => {
          const nodeCenterX = node.position.x + node.size.width / 2;
          const nodeCenterY = node.position.y + node.size.height / 2;
          const dist = Math.hypot(nodeCenterX - centerX, nodeCenterY - centerY);
          
          if (dist < minDistance) {
              minDistance = dist;
              nearestId = node.id;
          }
      });

      if (nearestId) {
          const node = state.nodes.find(n => n.id === nearestId);
          if (node) {
              // Center the node
              const nodeCenterX = node.position.x + node.size.width / 2;
              const nodeCenterY = node.position.y + node.size.height / 2;
              
              const newPanX = viewportWidth / 2 - nodeCenterX * state.zoom;
              const newPanY = viewportHeight / 2 - nodeCenterY * state.zoom;

              dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
              handleHighlightNode(nearestId);
          }
      }
  };

  const handleNodeMove = (id: string, newPos: Position) => {
    const node = state.nodes.find(n => n.id === id);
    if (!node) return;

    // Use current dimensions (handle minimized state)
    const w = node.isMinimized ? 250 : node.size.width;
    const h = node.isMinimized ? 40 : node.size.height;
    
    // Calculate deltas based on original position
    const deltaX = newPos.x - node.position.x;
    const deltaY = newPos.y - node.position.y;

    // Group Drag Logic
    if (state.selectedNodeIds.includes(id)) {
        // Move all selected nodes by delta
        state.selectedNodeIds.forEach(selId => {
            if (selId === id) return; // Will handle main node later to allow snapping
            const selNode = state.nodes.find(n => n.id === selId);
            if (selNode) {
                dispatchLocal({ 
                    type: 'UPDATE_NODE_POSITION', 
                    payload: { 
                        id: selId, 
                        position: { x: selNode.position.x + deltaX, y: selNode.position.y + deltaY } 
                    } 
                });
            }
        });
    }

    // Snapping Logic
    let snappedX = newPos.x;
    let snappedY = newPos.y;

    const SNAP_THRESHOLD = 25; 
    const newSnapLines: {x1: number, y1: number, x2: number, y2: number}[] = [];

    // Find connected nodes
    const connectedNodeIds = new Set<string>();
    state.connections.forEach(c => {
        if (c.sourceNodeId === id) connectedNodeIds.add(c.targetNodeId);
        if (c.targetNodeId === id) connectedNodeIds.add(c.sourceNodeId);
    });

    let bestVerticalSnap: { x: number, line: any, dist: number } | null = null;
    let bestHorizontalSnap: { y: number, line: any, dist: number } | null = null;

    // Calculate proposed center
    let cx = snappedX + w / 2;
    let cy = snappedY + h / 2;

    // Check against connected nodes
    state.nodes.forEach(other => {
        if (other.id === id) return;
        if (state.selectedNodeIds.includes(other.id)) return; // Don't snap to moving group members
        if (!connectedNodeIds.has(other.id)) return;

        const ow = other.isMinimized ? 250 : other.size.width;
        const oh = other.isMinimized ? 40 : other.size.height;
        const ocx = other.position.x + ow / 2;
        const ocy = other.position.y + oh / 2;

        // Vertical Snap (Align Centers)
        const distV = Math.abs(cx - ocx);
        if (distV < SNAP_THRESHOLD) {
             if (!bestVerticalSnap || distV < bestVerticalSnap.dist) {
                 const minY = Math.min(newPos.y, other.position.y);
                 const maxY = Math.max(newPos.y + h, other.position.y + oh);
                 bestVerticalSnap = {
                     x: ocx - w/2,
                     dist: distV,
                     line: { x1: ocx, y1: minY - 20, x2: ocx, y2: maxY + 20 }
                 };
             }
        }

        // Horizontal Snap
        const distH = Math.abs(cy - ocy);
        if (distH < SNAP_THRESHOLD) {
             if (!bestHorizontalSnap || distH < bestHorizontalSnap.dist) {
                 const minX = Math.min(newPos.x, other.position.x);
                 const maxX = Math.max(newPos.x + w, other.position.x + ow);
                 bestHorizontalSnap = {
                     y: ocy - h/2,
                     dist: distH,
                     line: { x1: minX - 20, y1: ocy, x2: maxX + 20, y2: ocy }
                 }
             }
        }
    });

    if (bestVerticalSnap) {
        snappedX = bestVerticalSnap.x;
        newSnapLines.push(bestVerticalSnap.line);
    }
    if (bestHorizontalSnap) {
        snappedY = bestHorizontalSnap.y;
        newSnapLines.push(bestHorizontalSnap.line);
    }

    setSnapLines(newSnapLines);

    // If snapped, re-adjust group members based on snap delta
    if (state.selectedNodeIds.includes(id)) {
        const snapDeltaX = snappedX - newPos.x;
        const snapDeltaY = snappedY - newPos.y;
        
        if (snapDeltaX !== 0 || snapDeltaY !== 0) {
             state.selectedNodeIds.forEach(selId => {
                 if (selId === id) return;
                 const selNode = state.nodes.find(n => n.id === selId);
                 if (selNode) {
                     // Total movement = raw delta + snap delta
                     const finalDeltaX = deltaX + snapDeltaX;
                     const finalDeltaY = deltaY + snapDeltaY;
                     dispatchLocal({ 
                        type: 'UPDATE_NODE_POSITION', 
                        payload: { 
                            id: selId, 
                            position: { x: selNode.position.x + finalDeltaX, y: selNode.position.y + finalDeltaY } 
                        } 
                    });
                 }
             });
        }
    }

    dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: { x: snappedX, y: snappedY } } });
  };

  const handleNodeDragEnd = (id: string) => {
    setSnapLines([]);
  };

  const handleContextMenu = (e: React.MouseEvent, nodeId?: string) => {
    e.preventDefault();
    const node = nodeId ? state.nodes.find(n => n.id === nodeId) : undefined;
    
    // Check Feasibility for Alignment
    let canAlignHorizontal = false;
    let canAlignVertical = false;

    if (nodeId && state.selectedNodeIds.includes(nodeId) && state.selectedNodeIds.length > 1) {
        const selectedNodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
        const targetNode = node!;
        const targetCenterY = targetNode.position.y + (targetNode.isMinimized ? 40 : targetNode.size.height) / 2;
        const targetCenterX = targetNode.position.x + (targetNode.isMinimized ? 250 : targetNode.size.width) / 2;

        // Check Horizontal (Align Y)
        const wouldOverlapH = selectedNodes.some((n1, i) => {
            const h1 = n1.isMinimized ? 40 : n1.size.height;
            const y1 = targetCenterY - h1/2;
            const w1 = n1.isMinimized ? 250 : n1.size.width;
            
            return selectedNodes.some((n2, j) => {
                if (i === j) return false;
                const h2 = n2.isMinimized ? 40 : n2.size.height;
                // Overlap condition: X ranges overlap.
                return (n1.position.x < n2.position.x + (n2.isMinimized ? 250 : n2.size.width)) && (n1.position.x + w1 > n2.position.x);
            });
        });
        canAlignHorizontal = !wouldOverlapH;

        // Check Vertical (Align X)
        const wouldOverlapV = selectedNodes.some((n1, i) => {
            const w1 = n1.isMinimized ? 250 : n1.size.width;
            const x1 = targetCenterX - w1/2;
            const h1 = n1.isMinimized ? 40 : n1.size.height;

            return selectedNodes.some((n2, j) => {
                if (i === j) return false;
                const h2 = n2.isMinimized ? 40 : n2.size.height;
                // Overlap condition: Y ranges overlap.
                return (n1.position.y < n2.position.y + h2) && (n1.position.y + h1 > n2.position.y);
            });
        });
        canAlignVertical = !wouldOverlapV;
    }

    setContextMenu({ 
        x: e.clientX, 
        y: e.clientY, 
        targetNodeId: nodeId, 
        targetNode: node 
    });
    (setContextMenu as any)(prev => ({ ...prev, x: e.clientX, y: e.clientY, targetNodeId: nodeId, targetNode: node, canAlignHorizontal, canAlignVertical }));
  };

  const handleAlign = (type: 'horizontal' | 'vertical') => {
      if (!contextMenu?.targetNodeId) return;
      const targetId = contextMenu.targetNodeId;
      const targetNode = state.nodes.find(n => n.id === targetId);
      if (!targetNode) return;

      const selectedNodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));

      selectedNodes.forEach(node => {
          if (node.id === targetId) return;
          
          if (type === 'horizontal') {
              // Align Centers Y
              const targetCenterY = targetNode.position.y + (targetNode.isMinimized ? 40 : targetNode.size.height) / 2;
              const nodeH = node.isMinimized ? 40 : node.size.height;
              const newY = targetCenterY - nodeH / 2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: node.position.x, y: newY } } });
          } else {
              // Align Centers X
              const targetCenterX = targetNode.position.x + (targetNode.isMinimized ? 250 : targetNode.size.width) / 2;
              const nodeW = node.isMinimized ? 250 : node.size.width;
              const newX = targetCenterX - nodeW / 2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: newX, y: node.position.y } } });
          }
      });
      setContextMenu(null);
  };

  const handlePortContextMenu = (e: React.MouseEvent, portId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId)) {
        setContextMenu({ x: e.clientX, y: e.clientY, targetPortId: portId });
    }
  };

  const handleBgPointerDown = (e: React.PointerEvent) => {
      e.preventDefault(); 
      if (isPinching.current) return;
      
      // Multi-Selection Start
      if (e.ctrlKey) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
              const x = (e.clientX - rect.left - state.pan.x) / state.zoom;
              const y = (e.clientY - rect.top - state.pan.y) / state.zoom;
              setSelectionBox({ x, y, w: 0, h: 0, startX: x, startY: y });
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
          }
      }

      // Clear Selection if clicking empty space without Ctrl
      if (!e.ctrlKey && state.selectedNodeIds.length > 0) {
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [] });
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      setIsPanning(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isPinching.current) return;

    if (selectionBox && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const currentX = (e.clientX - rect.left - state.pan.x) / state.zoom;
        const currentY = (e.clientY - rect.top - state.pan.y) / state.zoom;
        
        const x = Math.min(selectionBox.startX, currentX);
        const y = Math.min(selectionBox.startY, currentY);
        const w = Math.abs(currentX - selectionBox.startX);
        const h = Math.abs(currentY - selectionBox.startY);
        
        setSelectionBox({ ...selectionBox, x, y, w, h });
        return;
    }

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
    if (selectionBox) {
        // Finalize Selection
        const selectedIds: string[] = [];
        
        const prevSelected = new Set(state.selectedNodeIds);

        state.nodes.forEach(node => {
            const nw = node.isMinimized ? 250 : node.size.width;
            const nh = node.isMinimized ? 40 : node.size.height;
            
            // Check intersection
            if (
                node.position.x < selectionBox.x + selectionBox.w &&
                node.position.x + nw > selectionBox.x &&
                node.position.y < selectionBox.y + selectionBox.h &&
                node.position.y + nh > selectionBox.y
            ) {
                prevSelected.add(node.id);
            }
        });
        
        dispatchLocal({ type: 'SET_SELECTED_NODES', payload: Array.from(prevSelected) });
        setSelectionBox(null);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        return;
    }

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

    const handleToggleRun = (id: string) => {
        const isRunning = state.runningPreviewIds.includes(id);
        const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
        
        if (isRunning) {
             dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: false } });
             dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
             if (iframe) {
                 iframe.srcdoc = '<body style="background-color: #000; color: #555; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; font-family: sans-serif;">STOPPED</body>';
             }
        } else {
             dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: true } });
             dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
        }
    };

    const handleRefresh = (id: string) => {
         const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
         if (iframe) {
              const compiled = compilePreview(id, state.nodes, state.connections, true);
              iframe.srcdoc = compiled;
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

    const handleCancelAi = (nodeId: string) => {
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
    };

    const handleAiGenerate = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node || node.type !== 'CODE') return;

        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

        try {
             const apiKey = process.env.API_KEY;
             if (!apiKey) throw new Error("API Key missing");
             
             const ai = new GoogleGenAI({ apiKey });
             let prompt = "";
             let systemInstruction = "";

             if (action === 'optimize') {
                 systemInstruction = "You are an expert code optimizer. Return ONLY the optimized code.";
                 prompt = `Optimize this code:\n${node.content}`;
             } else {
                 systemInstruction = "You are an expert coder. Modify the code as requested. Return ONLY the code.";
                 prompt = `Request: ${promptText}\nCode:\n${node.content}`;
             }

             const response = await ai.models.generateContent({
                 model: 'gemini-3-flash-preview',
                 contents: prompt,
                 config: { systemInstruction }
             });

             const text = response.text;
             if (text) {
                 const clean = cleanAiOutput(text);
                 dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: clean } });
             }
        } catch (e: any) {
            alert(e.message);
        } finally {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
        }
    };

    const handleFixError = async (nodeId: string, errorMsg: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node) return;

        // Find connected source code
        const sources = getAllConnectedSources(nodeId, 'source', state.nodes, state.connections);
        if (sources.length === 0) {
            alert("No source code connected to this terminal.");
            return;
        }
        
        const sourceNode = sources[0]; // Assume first one for now
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: sourceNode.id, isLoading: true } });

        try {
            const apiKey = process.env.API_KEY;
            if (!apiKey) throw new Error("API Key missing");
            const ai = new GoogleGenAI({ apiKey });

            const prompt = `Fix this error in the code:\nError: ${errorMsg}\n\nCode:\n${sourceNode.content}`;
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: prompt,
                config: {
                    systemInstruction: "You are a debugger. Return ONLY the full fixed code."
                }
            });
            
            const text = response.text;
            if (text) {
                const clean = cleanAiOutput(text);
                dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: sourceNode.id, content: clean } });
                handleHighlightNode(sourceNode.id);
            }

        } catch(e:any) {
            alert(e.message);
        } finally {
             dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: sourceNode.id, isLoading: false } });
        }
    };

    const handleSendMessage = async (nodeId: string, text: string) => {
        dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

        try {
            const node = state.nodes.find(n => n.id === nodeId);
            const contextNodes = (node?.contextNodeIds || [])
                .map(id => state.nodes.find(n => n.id === id))
                .filter(n => n && n.type === 'CODE');
            
            const contextStr = contextNodes.map(n => `File: ${n!.title}\n${n!.content}`).join('\n\n');
            
            const apiKey = process.env.API_KEY;
             if (!apiKey) throw new Error("API Key missing");
            const ai = new GoogleGenAI({ apiKey });
            
            const systemInstruction = `You are a coding assistant. 
            Context: ${contextStr || 'No files selected.'}
            Tools: updateFile(filename, code), createFile(filename, content), connectNodes(sourceTitle, targetTitle).
            `;

            dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });

            const result = await ai.models.generateContentStream({
                model: 'gemini-3-flash-preview',
                contents: text,
                config: { 
                    systemInstruction,
                    tools: [{ functionDeclarations: [updateCodeFunction, createFileTool, connectNodesTool] }]
                }
            });

            let fullText = '';
            for await (const chunk of result) {
                
                if (chunk.text) {
                    fullText += chunk.text;
                    dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
                
                if (chunk.functionCalls) {
                     for (const call of chunk.functionCalls) {
                         if (call.name === 'updateFile') {
                             const args = call.args as any;
                             const target = state.nodes.find(n => n.type === 'CODE' && n.title === args.filename);
                             if (target) {
                                 dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } });
                                 fullText += `\n[Updated ${args.filename}]`;
                             } else {
                                 fullText += `\n[File not found: ${args.filename}]`;
                             }
                         } else if (call.name === 'createFile') {
                             const args = call.args as any;
                             const newId = `node-${Date.now()}`;
                             dispatchLocal({ type: 'ADD_NODE', payload: {
                                 id: newId,
                                 type: 'CODE',
                                 title: args.filename,
                                 content: args.content,
                                 position: findSafePosition({x: 100, y: 100}, state.nodes, 450, 300),
                                 size: { width: 450, height: 300 },
                                 autoHeight: true
                             }});
                             fullText += `\n[Created ${args.filename}]`;
                         }
                         // handle connectNodes...
                     }
                     dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
            }

        } catch (e: any) {
             dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${e.message}` } } });
        } finally {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
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

  const handleToggleSelectNode = (id: string, multi: boolean) => {
      if (multi) {
          const newSelection = state.selectedNodeIds.includes(id) 
              ? state.selectedNodeIds.filter(sid => sid !== id)
              : [...state.selectedNodeIds, id];
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: newSelection });
      } else {
          dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [id] });
      }
  };

  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3">
        <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">Coding Arena</h1>
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
            onClick={() => { if(confirm('Reset?')) { localStorage.removeItem('coding-arena-v1'); window.location.reload(); } }}
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
                pointerEvents: 'none',
                transition: isPanning ? 'none' : 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)' 
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

                {/* Selection Box */}
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

                <svg className="absolute top-0 left-0 w-full h-full overflow-visible pointer-events-none z-0">
                    {/* Snap Lines Layer */}
                    {snapLines.map((line, i) => (
                        <line 
                            key={`snap-${i}`}
                            x1={line.x1} y1={line.y1} 
                            x2={line.x2} y2={line.y2}
                            stroke="#22d3ee" // Cyan accent
                            strokeWidth="2"
                            strokeDasharray="5,5"
                            className="opacity-80 animate-in fade-in duration-75"
                        />
                    ))}

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
                                isSelected={state.selectedNodeIds.includes(node.id)}
                                isHighlighted={node.id === highlightedNodeId}
                                isRunning={state.runningPreviewIds.includes(node.id)}
                                scale={state.zoom}
                                isConnected={isConnected}
                                onMove={handleNodeMove}
                                onDragEnd={handleNodeDragEnd}
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
                                onToggleMinimize={(id) => dispatchLocal({ type: 'TOGGLE_MINIMIZE', payload: { id } })}
                                onSelect={handleToggleSelectNode}
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
                selectedNodeIds={state.selectedNodeIds}
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
                onAlign={handleAlign}
                canAlignHorizontal={(contextMenu as any).canAlignHorizontal}
                canAlignVertical={(contextMenu as any).canAlignVertical}
                onClose={() => setContextMenu(null)} 
            />
        </>
      )}
    </div>
  );
}
