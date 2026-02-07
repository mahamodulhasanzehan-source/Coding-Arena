
import React, { useReducer, useState, useRef, useEffect, useMemo } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { GraphState, Action, NodeData, NodeType, LogEntry, UserPresence, Position } from './types';
import { NODE_DEFAULTS, getPortsForNode } from './constants';
import { compilePreview, calculatePortPosition, getRelatedNodes, getAllConnectedSources, getConnectedSource } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, UploadCloud, Users, Download, Search, AlertTriangle } from 'lucide-react';
import Prism from 'prismjs';
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { auth, onAuthStateChanged, db, doc, getDoc, setDoc, deleteDoc } from './firebase';
import JSZip from 'jszip';

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
        if (!action.payload) return state;
        
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
                     return {
                         ...n,
                         isMinimized: true,
                         expandedSize: n.size, 
                         size: { width: n.size.width, height: 40 }
                     };
                } else {
                     const restoredSize = n.expandedSize || NODE_DEFAULTS[n.type];
                     return {
                         ...n,
                         isMinimized: false,
                         expandedSize: undefined,
                         size: restoredSize,
                     };
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

const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Create or Update the CONTENT of a file. DO NOT use this to move files. Only use this if the file text needs to change.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the file (e.g., script.js).' },
            code: { type: Type.STRING, description: 'The NEW full content of the file.' }
        },
        required: ['filename', 'code']
    }
};

const deleteFileFunction: FunctionDeclaration = {
    name: 'deleteFile',
    description: 'Delete a file (node) from the project.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the file to delete.' }
        },
        required: ['filename']
    }
};

const moveFileFunction: FunctionDeclaration = {
    name: 'moveFile',
    description: 'Move an EXISTING file into a folder or to root. This REWIRES the connections. It does NOT change content.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the existing file node to move.' },
            targetFolderName: { type: Type.STRING, description: 'The exact name of the destination folder node. Leave empty/null to move to root.' }
        },
        required: ['filename']
    }
};

const renameFileFunction: FunctionDeclaration = {
    name: 'renameFile',
    description: 'Rename a file node without changing its connections or content.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            oldName: { type: Type.STRING, description: 'The current name of the file.' },
            newName: { type: Type.STRING, description: 'The new name for the file.' }
        },
        required: ['oldName', 'newName']
    }
};

type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

const getRandomColor = () => {
    const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'];
    return colors[Math.floor(Math.random() * colors.length)];
};

const cleanAiOutput = (text: string): string => {
    return text.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');
};

// Timeout Wrapper for AI Calls
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

async function performGeminiCall<T>(operation: (ai: GoogleGenAI) => Promise<T>): Promise<T> {
    const keys = [process.env.API_KEY, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5].filter((k): k is string => !!k && k.length > 0);
    
    if (keys.length === 0) throw new Error("No Gemini API Keys configured.");

    let lastError: any;

    for (const apiKey of keys) {
        try {
            const ai = new GoogleGenAI({ apiKey });
            // Wrap operation with a 60-second timeout
            return await withTimeout(operation(ai), 60000, "AI Operation Timed Out (60s limit).");
        } catch (error: any) {
            lastError = error;
            if (error.status === 429 || error.message?.includes('429') || error.status === 503) {
                console.warn(`API Key ${apiKey.slice(0,5)}... rate limited or unavailable. Switching...`);
                continue; 
            }
            throw error;
        }
    }
    throw lastError; 
}

const SYSTEM_INSTRUCTIONS = `You are a coding assistant in NodeCode Studio.

RULES:
1. To EDIT content, use 'updateFile'. 
   - DO NOT use this to move files.
   - DO NOT use this to create duplicate files in folders.
2. To MOVE a file, use 'moveFile(filename, folderName)'. 
   - This operates on EXISTING files listed in the project structure.
   - It simply changes the visual connections.
   - If the target folder doesn't exist, it will be created automatically.
   - To move to root, leave targetFolderName empty.
3. To RENAME a file, use 'renameFile(oldName, newName)'.
   - Renaming only changes the Title.
   - If you need to "Rename and Move" (e.g. move 'components/button.js' to 'button.js' in 'components' folder):
     First RENAME 'components/button.js' to 'button.js'.
     Then MOVE 'button.js' to 'components'.
4. Do NOT use paths in filenames (e.g. 'folder/file.js'). Use 'file.js' and put it inside a 'folder' node.
5. ALWAYS check the 'CURRENT PROJECT FILES' list. Do not hallucinate files that are not there.
`;

export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
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
  const [userColor] = useState(getRandomColor());
  const [snapLines, setSnapLines] = useState<{x1: number, y1: number, x2: number, y2: number}[]>([]);
  const [maximizedNodeId, setMaximizedNodeId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ x: number, y: number, w: number, h: number, startX: number, startY: number } | null>(null);

  const sessionId = useMemo(() => `session-${Math.random().toString(36).substr(2, 9)}`, []);
  const isLocalChange = useRef(false);
  const lastTouchDist = useRef<number | null>(null);
  const isPinching = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastSentStateRef = useRef<Record<string, any>>({});
  const longPressTimer = useRef<any>(null);
  const touchStartPos = useRef<{ x: number, y: number } | null>(null);

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

  const displayNodes = useMemo(() => {
    return state.nodes.map(node => {
        const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId);
        if (collaborator && collaborator.draggingPosition) {
            return { ...node, position: collaborator.draggingPosition, _remoteDrag: true };
        }
        return node;
    });
  }, [state.nodes, state.collaborators, sessionId]);

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

  // ... (Other useEffects for iframe sync, etc. remain the same)

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

  // --- AI HANDLERS ---

  const handleSendMessage = async (nodeId: string, text: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      
      const contextFiles = (node.contextNodeIds || []).map(id => state.nodes.find(n => n.id === id)).filter(n => n && n.type === 'CODE');
      const nodesToLock = new Set<string>([nodeId, ...contextFiles.map(n => n!.id)]);
      
      // Find folders connected to context files to lock them too
      contextFiles.forEach(file => {
          const folderConn = state.connections.find(c => c.sourceNodeId === file!.id && state.nodes.find(n => n.id === c.targetNodeId)?.type === 'FOLDER');
          if (folderConn) nodesToLock.add(folderConn.targetNodeId);
      });

      dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
      nodesToLock.forEach(id => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id, isLoading: true } }));

      // Provide structure context so AI knows about all files, not just selected ones
      const structureContext = state.nodes
        .filter(n => n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT' || n.type === 'FOLDER')
        .map(n => `- ${n.title} (${n.type})`)
        .join('\n');

      const fileContext = contextFiles.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');
      
      const dynamicSystemInstruction = `${SYSTEM_INSTRUCTIONS}

      CURRENT PROJECT FILES (Structural Context):
      ${structureContext}

      Use this list to identify files for moving or renaming. Do not invent new files.
      `;

      try {
          dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });
          
          await performGeminiCall(async (ai) => {
              const result = await ai.models.generateContentStream({ 
                  model: 'gemini-3-flash-preview', 
                  contents: [{ role: 'user', parts: [{ text: `Query: ${text}\n\nSelected File Content Context:\n${fileContext}` }] }], 
                  config: { 
                      systemInstruction: dynamicSystemInstruction, 
                      tools: [{ functionDeclarations: [updateCodeFunction, deleteFileFunction, moveFileFunction, renameFileFunction] }] 
                  } 
              });
              
              let fullText = '';
              const functionCalls: any[] = [];
              
              for await (const chunk of result) {
                  if (chunk.text) { 
                      fullText += chunk.text; 
                      dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } }); 
                  }
                  if (chunk.functionCalls) functionCalls.push(...chunk.functionCalls);
              }
              
              if (functionCalls.length > 0) {
                  let toolOutput = '';
                  // IMPORTANT: Create a local simulation of the node state to handle dependent batch operations
                  // like "Rename A to B" then "Move B". React state updates are async, so we must track locally.
                  let tempNodes = [...state.nodes];
                  
                  for (const call of functionCalls) {
                      if (call.name === 'updateFile') {
                          const args = call.args as any;
                          const fileName = args.filename;
                          const target = tempNodes.find(n => n.title === fileName && n.type === 'CODE');
                          
                          if (target) {
                              if (checkPermission(target.id)) { 
                                  dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } }); 
                                  toolOutput += `\n[Updated ${fileName}]`; 
                                  handleHighlightNode(target.id); 
                              } else { toolOutput += `\n[Error: ${fileName} is locked]`; }
                          } else {
                              // Create New File
                              const newNodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                              const chatNode = tempNodes.find(n => n.id === nodeId);
                              const pos = chatNode ? { x: chatNode.position.x + 50, y: chatNode.position.y + 50 } : { x: 100, y: 100 };
                              const newNode: NodeData = { id: newNodeId, type: 'CODE', title: fileName, content: args.code, position: pos, size: { width: 450, height: 300 }, autoHeight: false };
                              
                              dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                              tempNodes.push(newNode); // Update local state
                              toolOutput += `\n[Created ${fileName}]`;
                              
                              // Connect to context if applicable
                              const contextNode = tempNodes.find(n => n.id === nodeId);
                              if (contextNode && contextNode.type === 'CODE') {
                                  dispatchLocal({ type: 'CONNECT', payload: { id: `conn-auto-${Date.now()}`, sourceNodeId: newNodeId, sourcePortId: `${newNodeId}-out-dom`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                              }
                          }
                      } else if (call.name === 'moveFile') {
                          const args = call.args as any;
                          const { filename, targetFolderName } = args;
                          const targetNode = tempNodes.find(n => n.title === filename && (n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT'));
                          
                          if (targetNode && checkPermission(targetNode.id)) {
                              // 1. Disconnect current outputs (Local logic: we can't update state.connections locally easily without complex logic, so we just dispatch)
                              // We assume disconnect works based on ID.
                              const existingOutputs = state.connections.filter(c => c.sourceNodeId === targetNode.id && c.sourcePortId.includes('out-dom'));
                              existingOutputs.forEach(c => dispatchLocal({ type: 'DISCONNECT', payload: c.id }));

                              if (targetFolderName) {
                                  // Move to Folder
                                  let folderNode = tempNodes.find(n => n.type === 'FOLDER' && n.title === targetFolderName);
                                  
                                  if (!folderNode) {
                                      // Create folder if missing in TEMP nodes
                                      const folderId = `folder-${Date.now()}`;
                                      const newFolder: NodeData = { id: folderId, type: 'FOLDER', title: targetFolderName, content: '', position: { x: targetNode.position.x - 200, y: targetNode.position.y }, size: { width: 250, height: 300 } };
                                      
                                      dispatchLocal({ type: 'ADD_NODE', payload: newFolder });
                                      tempNodes.push(newFolder); // Add to local tracking so subsequent moves use SAME folder
                                      folderNode = newFolder;
                                      toolOutput += `\n[Created Folder ${targetFolderName}]`;
                                  }
                                  
                                  // Connect File -> Folder
                                  dispatchLocal({ type: 'CONNECT', payload: { id: `conn-${Date.now()}-${Math.random()}`, sourceNodeId: targetNode.id, sourcePortId: `${targetNode.id}-out-dom`, targetNodeId: folderNode.id, targetPortId: `${folderNode.id}-in-files` } });
                                  
                                  // Ensure Folder -> Context (Chat Node's Context)
                                  const contextNode = tempNodes.find(n => n.id === nodeId);
                                  if (contextNode && contextNode.type === 'CODE') {
                                       // Check if folder connection dispatch is needed (simplification: just try connecting)
                                       dispatchLocal({ type: 'CONNECT', payload: { id: `conn-ctx-${Date.now()}-${Math.random()}`, sourceNodeId: folderNode.id, sourcePortId: `${folderNode.id}-out-folder`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                                  }
                                  toolOutput += `\n[Moved ${filename} to ${targetFolderName}]`;
                              } else {
                                  // Move to Root
                                  const contextNode = tempNodes.find(n => n.id === nodeId);
                                  if (contextNode && contextNode.type === 'CODE') {
                                      dispatchLocal({ type: 'CONNECT', payload: { id: `conn-root-${Date.now()}-${Math.random()}`, sourceNodeId: targetNode.id, sourcePortId: `${targetNode.id}-out-dom`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                                      toolOutput += `\n[Moved ${filename} to Root]`;
                                  }
                              }
                          } else {
                              toolOutput += `\n[Error: Could not find ${filename} to move. Available files: ${tempNodes.map(n=>n.title).join(', ')}]`;
                          }
                      } else if (call.name === 'renameFile') {
                          const args = call.args as any;
                          const { oldName, newName } = args;
                          const targetIndex = tempNodes.findIndex(n => n.title === oldName && n.type === 'CODE');
                          
                          if (targetIndex !== -1 && checkPermission(tempNodes[targetIndex].id)) {
                              const target = tempNodes[targetIndex];
                              dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id: target.id, title: newName } });
                              
                              // Update local state so subsequent operations (like move) find it by NEW name
                              tempNodes[targetIndex] = { ...target, title: newName };
                              
                              toolOutput += `\n[Renamed ${oldName} to ${newName}]`;
                          } else {
                              toolOutput += `\n[Error: Could not rename ${oldName}]`;
                          }
                      } else if (call.name === 'deleteFile') {
                          const args = call.args as any;
                          const targetIndex = tempNodes.findIndex(n => n.title === args.filename && n.type === 'CODE');
                          if (targetIndex !== -1) {
                              const target = tempNodes[targetIndex];
                              if (checkPermission(target.id)) {
                                  dispatchLocal({ type: 'DELETE_NODE', payload: target.id });
                                  tempNodes.splice(targetIndex, 1);
                                  toolOutput += `\n[Deleted ${args.filename}]`;
                              }
                          }
                      }
                  }
                  if (toolOutput) dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText + toolOutput } });
              }
          });
      } catch (error: any) { 
          dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${error.message}` } } }); 
      } finally { 
          nodesToLock.forEach(id => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id, isLoading: false } })); 
      }
  };

  const handleAiGenerate = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
      const startNode = state.nodes.find(n => n.id === nodeId);
      if (!startNode || startNode.type !== 'CODE' || !checkPermission(nodeId)) return;
      const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
      const targetNodes = relatedNodes.filter(n => n.type === 'CODE' || n.type === 'FOLDER');
      
      targetNodes.forEach(n => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: true } }));
      try {
          const fileContext = targetNodes.filter(n => n.type === 'CODE').map(n => `Filename: ${n.title}\nContent:\n${n.content}`).join('\n\n');
          
          const structureContext = state.nodes
            .filter(n => n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT' || n.type === 'FOLDER')
            .map(n => `- ${n.title} (${n.type})`)
            .join('\n');

          let userPrompt = action === 'optimize' ? `Optimize the file ${startNode.title}.` : `Request: ${promptText}\n\n(Focus on ${startNode.title}...)`;
          
          const dynamicSystemInstruction = `${SYSTEM_INSTRUCTIONS}

          CURRENT PROJECT FILES (Structural Context):
          ${structureContext}
          `;

          await performGeminiCall(async (ai) => {
               const result = await ai.models.generateContent({ 
                   model: 'gemini-3-flash-preview', 
                   contents: userPrompt, 
                   config: { 
                       systemInstruction: dynamicSystemInstruction, 
                       tools: [{ functionDeclarations: [updateCodeFunction, deleteFileFunction, moveFileFunction, renameFileFunction] }] 
                   } 
               });
               const response = result;
               const functionCalls = response.functionCalls;
               
               if (functionCalls && functionCalls.length > 0) {
                   // Create local simulation for batch processing
                   let tempNodes = [...state.nodes];

                   for (const call of functionCalls) {
                       if (call.name === 'updateFile') {
                           const args = call.args as any;
                           const target = tempNodes.find(n => n.type === 'CODE' && n.title === args.filename);
                           if (target) { 
                               if (checkPermission(target.id)) { 
                                   dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } }); 
                                   handleHighlightNode(target.id); 
                               } 
                           } else {
                               // Handle creation
                               const newNodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                               const pos = { x: startNode.position.x + 50, y: startNode.position.y + 50 };
                               const newNode: NodeData = { id: newNodeId, type: 'CODE', title: args.filename, content: args.code, position: pos, size: { width: 450, height: 300 }, autoHeight: false };
                               dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                               tempNodes.push(newNode);
                               
                               dispatchLocal({ type: 'CONNECT', payload: { id: `conn-auto-${Date.now()}`, sourceNodeId: newNodeId, sourcePortId: `${newNodeId}-out-dom`, targetNodeId: startNode.id, targetPortId: `${startNode.id}-in-file` } });
                           }
                       } else if (call.name === 'moveFile') {
                           const args = call.args as any;
                           const { filename, targetFolderName } = args;
                           const target = tempNodes.find(n => n.title === filename && (n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT'));
                           
                           if (target && checkPermission(target.id)) {
                               const existingOutputs = state.connections.filter(c => c.sourceNodeId === target.id && c.sourcePortId.includes('out-dom'));
                               existingOutputs.forEach(c => dispatchLocal({ type: 'DISCONNECT', payload: c.id }));
                               
                               if (targetFolderName) {
                                   let folderNode = tempNodes.find(n => n.type === 'FOLDER' && n.title === targetFolderName);
                                   if (!folderNode) {
                                      const folderId = `folder-${Date.now()}`;
                                      const newFolder: NodeData = { id: folderId, type: 'FOLDER', title: targetFolderName, content: '', position: { x: target.position.x - 200, y: target.position.y }, size: { width: 250, height: 300 } };
                                      dispatchLocal({ type: 'ADD_NODE', payload: newFolder });
                                      tempNodes.push(newFolder);
                                      folderNode = newFolder;
                                   }
                                   dispatchLocal({ type: 'CONNECT', payload: { id: `conn-${Date.now()}`, sourceNodeId: target.id, sourcePortId: `${target.id}-out-dom`, targetNodeId: folderNode.id, targetPortId: `${folderNode.id}-in-files` } });
                                   
                                   const isConnected = state.connections.some(c => c.sourceNodeId === folderNode!.id && c.targetNodeId === startNode.id);
                                   if (!isConnected) {
                                       dispatchLocal({ type: 'CONNECT', payload: { id: `conn-ctx-${Date.now()}`, sourceNodeId: folderNode!.id, sourcePortId: `${folderNode!.id}-out-folder`, targetNodeId: startNode.id, targetPortId: `${startNode.id}-in-file` } });
                                   }
                               } else {
                                   dispatchLocal({ type: 'CONNECT', payload: { id: `conn-root-${Date.now()}`, sourceNodeId: target.id, sourcePortId: `${target.id}-out-dom`, targetNodeId: startNode.id, targetPortId: `${startNode.id}-in-file` } });
                               }
                           }
                       } else if (call.name === 'renameFile') {
                           const args = call.args as any;
                           const targetIndex = tempNodes.findIndex(n => n.title === args.oldName && n.type === 'CODE');
                           if (targetIndex !== -1 && checkPermission(tempNodes[targetIndex].id)) {
                               const target = tempNodes[targetIndex];
                               dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id: target.id, title: args.newName } });
                               tempNodes[targetIndex] = { ...target, title: args.newName };
                           }
                       } else if (call.name === 'deleteFile') {
                           const args = call.args as any;
                           const targetIndex = tempNodes.findIndex(n => n.type === 'CODE' && n.title === args.filename);
                           if (targetIndex !== -1 && checkPermission(tempNodes[targetIndex].id)) {
                               dispatchLocal({ type: 'DELETE_NODE', payload: tempNodes[targetIndex].id });
                               tempNodes.splice(targetIndex, 1);
                           }
                       }
                   }
               } else if (response.text) {
                   dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: cleanAiOutput(response.text) } });
                   handleHighlightNode(nodeId);
               }
          });
      } catch (e: any) { alert(`AI Error: ${e.message}`); } finally { targetNodes.forEach(n => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: false } })); }
  };

  const handleCancelAi = (nodeId: string) => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
  
  const handleFixError = (nodeId: string, error: string) => {
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      const connectedPreview = getConnectedSource(nodeId, 'logs', state.nodes, state.connections);
      if (!connectedPreview) return;
      const connectedCode = getConnectedSource(connectedPreview.id, 'dom', state.nodes, state.connections);
      if (!connectedCode || !checkPermission(connectedCode.id)) return;
      handleAiGenerate(connectedCode.id, 'prompt', `Fix this error: ${error}`);
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
    // Calculate viewport center in world coordinates
    const viewportCenterX = window.innerWidth / 2;
    const viewportCenterY = window.innerHeight / 2;
    
    // We want the logic to find the node closest to the CURRENT CENTER of the screen
    // World coordinates of the current screen center:
    const worldCenterX = (viewportCenterX - state.pan.x) / state.zoom;
    const worldCenterY = (viewportCenterY - state.pan.y) / state.zoom;
    
    let nearestNode: NodeData | null = null;
    let minDist = Infinity;
    
    state.nodes.forEach(n => {
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
        
        // Calculate correct Pan to center this node on screen
        const nW = target.size.width;
        const nH = target.isMinimized ? 40 : target.size.height;
        const targetCenterX = target.position.x + nW / 2;
        const targetCenterY = target.position.y + nH / 2;
        
        // Formula: ScreenX = WorldX * Zoom + PanX
        // We want ScreenX to be ViewportCenterX
        // PanX = ViewportCenterX - (WorldX * Zoom)
        
        const newPanX = viewportCenterX - (targetCenterX * state.zoom);
        const newPanY = viewportCenterY - (targetCenterY * state.zoom);
        
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    }
  };

  const handleNodeMove = (id: string, newPos: Position) => {
      // Basic movement
      dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id, position: newPos } });
      
      // Move selected siblings
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
      
      // Snap Lines Logic
      const SNAP_THRESHOLD = 5;
      const otherNodes = state.nodes.filter(n => n.id !== id && !state.selectedNodeIds.includes(n.id));
      const myNode = state.nodes.find(n => n.id === id);
      if (!myNode) return;
      
      // Re-fetch current position (it might have drifted due to raw events vs react state)
      // Actually, newPos is the raw intended position.
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

          // X Alignment
          if (Math.abs(newPos.x - other.position.x) < SNAP_THRESHOLD) {
              newSnapLines.push({ x1: other.position.x, y1: Math.min(newPos.y, other.position.y) - 20, x2: other.position.x, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          } else if (Math.abs(myCenterX - otherCenterX) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: otherCenterX, y1: Math.min(newPos.y, other.position.y) - 20, x2: otherCenterX, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          } else if (Math.abs((newPos.x + myW) - (other.position.x + otherW)) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: other.position.x + otherW, y1: Math.min(newPos.y, other.position.y) - 20, x2: other.position.x + otherW, y2: Math.max(newPos.y + myH, other.position.y + otherH) + 20 });
          }

          // Y Alignment
           if (Math.abs(newPos.y - other.position.y) < SNAP_THRESHOLD) {
              newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: other.position.y, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: other.position.y });
          } else if (Math.abs(myCenterY - otherCenterY) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: otherCenterY, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: otherCenterY });
          } else if (Math.abs((newPos.y + myH) - (other.position.y + otherH)) < SNAP_THRESHOLD) {
               newSnapLines.push({ x1: Math.min(newPos.x, other.position.x) - 20, y1: other.position.y + otherH, x2: Math.max(newPos.x + myW, other.position.x + otherW) + 20, y2: other.position.y + otherH });
          }
      });
      setSnapLines(newSnapLines);
  };
  
  const handleNodeDragEnd = (id: string) => { setSnapLines([]); };

  // --- UPDATED LAYOUT HANDLERS ---

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
              // Ensure we use 40px height if minimized, just in case state hasn't updated
              const targetH = targetNode.isMinimized ? 40 : targetNode.size.height;
              const nodeH = node.isMinimized ? 40 : node.size.height;
              
              const targetCenterY = targetNode.position.y + targetH / 2;
              const newY = targetCenterY - nodeH / 2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: node.position.x, y: newY } } });
          } else {
              // Align Centers X
              const targetCenterX = targetNode.position.x + (targetNode.size.width) / 2;
              const nodeW = node.size.width; // Width is handled by component sync, but center alignment relies on it.
              const newX = targetCenterX - nodeW / 2;
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: newX, y: node.position.y } } });
          }
      });
      setContextMenu(null);
  };

  const handleCompact = (type: 'horizontal' | 'vertical') => {
    const selectedNodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
    if (selectedNodes.length < 2) return;
    const GAP = 20;

    if (type === 'horizontal') {
        const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);
        let currentX = sorted[0].position.x;
        
        sorted.forEach(node => {
            if (node.position.x !== currentX) {
                 dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: currentX, y: node.position.y } } });
            }
            const w = node.size.width; 
            currentX += w + GAP;
        });
    } else {
        const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
        let currentY = sorted[0].position.y;
        
        sorted.forEach(node => {
            // Force update if position mismatch
            if (node.position.y !== currentY) {
                 dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: node.position.x, y: currentY } } });
            }
            // Use safe height for minimized nodes
            const h = node.isMinimized ? 40 : node.size.height;
            currentY += h + GAP;
        });
    }
    setContextMenu(null);
  };

  const handleDistribute = (type: 'horizontal' | 'vertical') => {
      const selectedNodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
      if (selectedNodes.length < 3) return;

      if (type === 'horizontal') {
          const sorted = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          
          const firstW = first.size.width;
          const totalSpan = last.position.x - (first.position.x + firstW);
          
          const innerNodes = sorted.slice(1, -1);
          const sumInnerW = innerNodes.reduce((acc, n) => acc + (n.size.width), 0);
          
          const totalGap = totalSpan - sumInnerW;
          const gap = totalGap / (sorted.length - 1);
          
          let currentX = first.position.x + firstW + gap;
          innerNodes.forEach(node => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: currentX, y: node.position.y } } });
              const w = node.size.width;
              currentX += w + gap;
          });
      } else {
          const sorted = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          
          // Use safe heights
          const firstH = first.isMinimized ? 40 : first.size.height;
          const totalSpan = last.position.y - (first.position.y + firstH);
          
          const innerNodes = sorted.slice(1, -1);
          const sumInnerH = innerNodes.reduce((acc, n) => acc + (n.isMinimized ? 40 : n.size.height), 0);
          
          const totalGap = totalSpan - sumInnerH;
          const gap = totalGap / (sorted.length - 1);
          
          let currentY = first.position.y + firstH + gap;
          innerNodes.forEach(node => {
              dispatchLocal({ type: 'UPDATE_NODE_POSITION', payload: { id: node.id, position: { x: node.position.x, y: currentY } } });
              const h = node.isMinimized ? 40 : node.size.height;
              currentY += h + gap;
          });
      }
      setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent | React.TouchEvent | any, nodeId?: string) => {
    if (e.preventDefault) e.preventDefault();
    if (maximizedNodeId) return;
    
    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.clientX !== undefined) {
        clientX = e.clientX;
        clientY = e.clientY;
    } else {
        return; 
    }

    const node = nodeId ? state.nodes.find(n => n.id === nodeId) : undefined;
    
    let canAlignHorizontal = false;
    let canAlignVertical = false;
    let canDistributeHorizontal = false;
    let canDistributeVertical = false;
    let canCompactHorizontal = false;
    let canCompactVertical = false;

    if (nodeId && state.selectedNodeIds.includes(nodeId) && state.selectedNodeIds.length > 1) {
        const selectedNodes = state.nodes.filter(n => state.selectedNodeIds.includes(n.id));
        
        // Alignment Checks
        const wouldOverlapH = selectedNodes.some((n1, i) => {
            const w1 = n1.size.width;
            return selectedNodes.some((n2, j) => {
                if (i === j) return false;
                return (n1.position.x < n2.position.x + w1) && (n1.position.x + w1 > n2.position.x);
            });
        });
        canAlignHorizontal = !wouldOverlapH;

        const wouldOverlapV = selectedNodes.some((n1, i) => {
            const h1 = n1.isMinimized ? 40 : n1.size.height;
            return selectedNodes.some((n2, j) => {
                if (i === j) return false;
                const h2 = n2.isMinimized ? 40 : n2.size.height;
                return (n1.position.y < n2.position.y + h2) && (n1.position.y + h1 > n2.position.y);
            });
        });
        canAlignVertical = !wouldOverlapV;

        // Compact Checks (Based on Alignment)
        const centerYs = selectedNodes.map(n => n.position.y + (n.isMinimized ? 40 : n.size.height)/2);
        const avgY = centerYs.reduce((a,b)=>a+b,0)/centerYs.length;
        const isAlignedH = centerYs.every(y => Math.abs(y - avgY) < 1);
        canCompactHorizontal = isAlignedH;

        const centerXs = selectedNodes.map(n => n.position.x + (n.size.width)/2);
        const avgX = centerXs.reduce((a,b)=>a+b,0)/centerXs.length;
        const isAlignedV = centerXs.every(x => Math.abs(x - avgX) < 1);
        canCompactVertical = isAlignedV;

        // Distribution Checks
        if (selectedNodes.length >= 3) {
            const sortedX = [...selectedNodes].sort((a, b) => a.position.x - b.position.x);
            const firstX = sortedX[0];
            const lastX = sortedX[sortedX.length - 1];
            const totalSpanX = lastX.position.x - (firstX.position.x + (firstX.size.width));
            const sumInnerWidths = sortedX.slice(1, -1).reduce((acc, n) => acc + (n.size.width), 0);
            const gapX = (totalSpanX - sumInnerWidths) / (sortedX.length - 1);
            canDistributeHorizontal = gapX >= 0;

            const sortedY = [...selectedNodes].sort((a, b) => a.position.y - b.position.y);
            const firstY = sortedY[0];
            const lastY = sortedY[sortedY.length - 1];
            const firstH = firstY.isMinimized ? 40 : firstY.size.height;
            const totalSpanY = lastY.position.y - (firstY.position.y + firstH);
            const sumInnerHeights = sortedY.slice(1, -1).reduce((acc, n) => acc + (n.isMinimized ? 40 : n.size.height), 0);
            const gapY = (totalSpanY - sumInnerHeights) / (sortedY.length - 1);
            canDistributeVertical = gapY >= 0;
        }
    }

    setContextMenu({ 
        x: clientX, 
        y: clientY, 
        targetNodeId: nodeId, 
        targetNode: node, 
        canAlignHorizontal, 
        canAlignVertical,
        canDistributeHorizontal, 
        canDistributeVertical,
        canCompactHorizontal, 
        canCompactVertical
    });
  };

  const handlePortContextMenu = (e: React.MouseEvent, portId: string) => { e.preventDefault(); e.stopPropagation(); if (state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId)) { setContextMenu({ x: e.clientX, y: e.clientY, targetPortId: portId }); } };
  
  const handleBgPointerDown = (e: React.PointerEvent) => {
      e.preventDefault(); 
      if (maximizedNodeId) return; 
      if (isPinching.current) return;
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
      if (!e.ctrlKey && state.selectedNodeIds.length > 0) { dispatchLocal({ type: 'SET_SELECTED_NODES', payload: [] }); }
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsPanning(true);
  };
  
  const handlePointerMove = (e: React.PointerEvent) => {
    if (maximizedNodeId) return;
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
    if (isPanning) { dispatch({ type: 'PAN', payload: { x: state.pan.x + e.movementX, y: state.pan.y + e.movementY } }); }
  };
  
  const handlePointerUp = (e: React.PointerEvent) => {
    if (selectionBox) {
        const selectedIds: string[] = [];
        const prevSelected = new Set(state.selectedNodeIds);
        state.nodes.forEach(node => {
            const nw = node.size.width;
            const nh = node.isMinimized ? 40 : node.size.height;
            if (node.position.x < selectionBox.x + selectionBox.w && node.position.x + nw > selectionBox.x && node.position.y < selectionBox.y + selectionBox.h && node.position.y + nh > selectionBox.y) {
                prevSelected.add(node.id);
            }
        });
        dispatchLocal({ type: 'SET_SELECTED_NODES', payload: Array.from(prevSelected) });
        setSelectionBox(null);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        return;
    }
    if (isPanning) { setIsPanning(false); (e.currentTarget as Element).releasePointerCapture(e.pointerId); }
    if (dragWire) { 
        if (dragWire.isInput) {
            // Dragging FROM input TO output
            const target = state.nodes.find(n => {
                const ports = getPortsForNode(n.id, n.type).filter(p => p.type === 'output');
                return ports.some(p => {
                    const pos = calculatePortPosition(n, p.id, 'output');
                    return Math.hypot(pos.x - dragWire.x2, pos.y - dragWire.y2) < 20;
                });
            });
            if (target) {
                const targetPort = getPortsForNode(target.id, target.type).find(p => p.type === 'output' && Math.hypot(calculatePortPosition(target, p.id, 'output').x - dragWire.x2, calculatePortPosition(target, p.id, 'output').y - dragWire.y2) < 20);
                if (targetPort) {
                     dispatchLocal({ type: 'CONNECT', payload: { id: `conn-${Date.now()}`, sourceNodeId: target.id, sourcePortId: targetPort.id, targetNodeId: dragWire.startNodeId, targetPortId: dragWire.startPortId } });
                }
            }
        } else {
             // Dragging FROM output TO input
             const target = state.nodes.find(n => {
                const ports = getPortsForNode(n.id, n.type).filter(p => p.type === 'input');
                return ports.some(p => {
                    const pos = calculatePortPosition(n, p.id, 'input');
                    return Math.hypot(pos.x - dragWire.x2, pos.y - dragWire.y2) < 20;
                });
            });
            if (target) {
                const targetPort = getPortsForNode(target.id, target.type).find(p => p.type === 'input' && Math.hypot(calculatePortPosition(target, p.id, 'input').x - dragWire.x2, calculatePortPosition(target, p.id, 'input').y - dragWire.y2) < 20);
                if (targetPort) {
                     dispatchLocal({ type: 'CONNECT', payload: { id: `conn-${Date.now()}`, sourceNodeId: dragWire.startNodeId, sourcePortId: dragWire.startPortId, targetNodeId: target.id, targetPortId: targetPort.id } });
                }
            }
        }
        setDragWire(null); 
    }
  };
  
  const handleTouchStart = (e: React.TouchEvent) => {
      if (maximizedNodeId) return;
      if (e.touches.length === 2) {
          isPinching.current = true;
          setIsPanning(false); 
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchDist.current = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
          if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
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
                  setContextMenu({ x: touch.clientX, y: touch.clientY });
                  if (navigator.vibrate) navigator.vibrate(50);
                  longPressTimer.current = null;
              }, 800);
          }
      }
  };
  
  const handleTouchMove = (e: React.TouchEvent) => {
      if (maximizedNodeId) return;
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
          if (diffX > 10 || diffY > 10) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
      }
  };
  
  const handleTouchEnd = (e: React.TouchEvent) => {
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
      touchStartPos.current = null;
      if (e.touches.length < 2) { isPinching.current = false; lastTouchDist.current = null; }
  };
  
  const handleWheel = (e: React.WheelEvent) => {
        if (maximizedNodeId) return;
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
             if (iframe) iframe.srcdoc = '<body style="background-color: #000; color: #555; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; font-family: sans-serif;">STOPPED</body>';
        } else {
             dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: true } });
             dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
        }
    };
    
    const handleRefresh = (id: string) => {
         const iframe = document.getElementById(`preview-iframe-${id}`) as HTMLIFrameElement;
         if (iframe) { const compiled = compilePreview(id, state.nodes, state.connections, true); iframe.srcdoc = compiled; }
    };
    
    const handlePortDown = (e: React.PointerEvent, portId: string, nodeId: string, isInput: boolean) => {
        e.stopPropagation(); e.preventDefault();
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const pos = calculatePortPosition(node, portId, isInput ? 'input' : 'output');
        setDragWire({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y, startPortId: portId, startNodeId: nodeId, isInput });
        e.currentTarget.setPointerCapture(e.pointerId);
    };
  const isConnected = (portId: string) => state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);

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
                // Updated transition for smoother "magnifying glass" effect
                transition: isPanning ? 'none' : 'transform 0.6s cubic-bezier(0.25, 1, 0.5, 1)' 
            }}
        >
            <div className="pointer-events-none w-full h-full relative">
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
                                onContextMenu={(e) => { e.stopPropagation(); handleContextMenu(e, node.id); }} // Pass handler for long press
                                onUpdateTitle={handleUpdateTitle}
                                onUpdateContent={(id, content) => {
                                    if(checkPermission(id)) {
                                        dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content } });
                                    }
                                }}
                                onSendMessage={handleSendMessage}
                                onStartContextSelection={handleStartContextSelection}
                                onAiAction={handleAiGenerate}
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
