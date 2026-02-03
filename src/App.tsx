import React, { useReducer, useState, useRef, useEffect } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { GraphState, Action, NodeData, NodeType, LogEntry, ChatMessage } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, CloudUpload } from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import { GoogleGenAI, FunctionDeclaration, Type, GenerateContentResponse } from "@google/genai";
import { signIn, db } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const initialState: GraphState = {
  nodes: [],
  connections: [],
  pan: { x: 0, y: 0 },
  zoom: 1,
  logs: {},
  runningPreviewIds: [],
  selectionMode: { isActive: false, requestingNodeId: '', selectedIds: [] },
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
        return { ...initialState, ...action.payload, logs: {}, runningPreviewIds: [], selectionMode: { isActive: false, requestingNodeId: '', selectedIds: [] } };
    default:
      return state;
  }
}

const getHighlightLanguage = (filename: string) => {
    // Provide robust fallback to avoid crashes if Prism language isn't loaded
    const ext = filename.split('.').pop()?.toLowerCase();
    
    if (ext === 'css') {
        return Prism.languages.css || Prism.languages.plain;
    }
    if (['js', 'jsx', 'ts', 'tsx'].includes(ext || '')) {
        return Prism.languages.javascript || Prism.languages.plain;
    }
    if (['html', 'xml', 'svg'].includes(ext || '')) {
        return Prism.languages.markup || Prism.languages.plain;
    }
    return Prism.languages.markup || Prism.languages.plain;
};

// --- Gemini Tool Definition ---
const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Update the code content of a specific file. Use this to write code or make changes. ALWAYS provide the FULL content of the file, not just the diff.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: {
                type: Type.STRING,
                description: 'The exact name of the file to update (e.g., script.js, index.html).'
            },
            code: {
                type: Type.STRING,
                description: 'The NEW full content of the file. Do not reduce code size unless optimizing. Maintain existing functionality.'
            }
        },
        required: ['filename', 'code']
    }
};

type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

export default function App() {
  const [state, dispatch] = useReducer(graphReducer, initialState);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, targetNodeId?: string, targetPortId?: string } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [dragWire, setDragWire] = useState<{ x1: number, y1: number, x2: number, y2: number, startPortId: string, startNodeId: string, isInput: boolean } | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('offline');
  const [userUid, setUserUid] = useState<string | null>(null);

  // Mobile Pinch Zoom Logic
  const lastTouchDist = useRef<number | null>(null);
  const isPinching = useRef(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  // --- Persistence Logic (Firebase) ---

  // 1. Initial Load
  useEffect(() => {
    const init = async () => {
      try {
        setSyncStatus('saving'); // Show connecting state
        const user = await signIn();
        setUserUid(user.uid);
        
        // Load data from Firestore
        const docRef = doc(db, 'nodecode_projects', user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && data.state) {
             const loadedState = JSON.parse(data.state);
             dispatch({ type: 'LOAD_STATE', payload: loadedState });
          }
        } else {
             // Load defaults if no cloud save exists
             const codeDefaults = NODE_DEFAULTS.CODE;
             const previewDefaults = NODE_DEFAULTS.PREVIEW;
             dispatch({ type: 'ADD_NODE', payload: { id: 'node-1', type: 'CODE', position: { x: 100, y: 100 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'index.html', content: '<h1>Hello World</h1>\n<link href="style.css" rel="stylesheet">\n<script src="app.js"></script>', autoHeight: true } });
             dispatch({ type: 'ADD_NODE', payload: { id: 'node-2', type: 'CODE', position: { x: 100, y: 300 }, size: { width: codeDefaults.width, height: codeDefaults.height }, title: 'style.css', content: 'body { background: #222; color: #fff; }', autoHeight: true } });
             dispatch({ type: 'ADD_NODE', payload: { id: 'node-3', type: 'PREVIEW', position: { x: 600, y: 100 }, size: { width: previewDefaults.width, height: previewDefaults.height }, title: previewDefaults.title, content: previewDefaults.content } });
        }
        setSyncStatus('synced');
        initialized.current = true;
      } catch (err) {
        console.error("Failed to connect", err);
        setSyncStatus('error');
      }
    };

    init();
  }, []);

  // 2. Debounced Save
  useEffect(() => {
    if (!initialized.current || !userUid) return;

    setSyncStatus('saving');
    const saveData = setTimeout(async () => {
      try {
         const docRef = doc(db, 'nodecode_projects', userUid);
         const stateToSave = {
            nodes: state.nodes.map(n => ({...n, isLoading: false})), // Don't persist loading state
            connections: state.connections,
            pan: state.pan,
            zoom: state.zoom
         };
         await setDoc(docRef, { 
             state: JSON.stringify(stateToSave),
             updatedAt: new Date().toISOString()
         });
         setSyncStatus('synced');
      } catch (e) {
          console.error("Save failed", e);
          setSyncStatus('error');
      }
    }, 2000); // 2 Second debounce

    return () => clearTimeout(saveData);
  }, [state.nodes, state.connections, state.pan, state.zoom, userUid]);

  // LIVE UPDATE LOOP
  useEffect(() => {
      state.runningPreviewIds.forEach(previewId => {
          const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
          if (iframe) {
               const compiled = compilePreview(previewId, state.nodes, state.connections, false);
               if (iframe.srcdoc !== compiled) {
                  iframe.srcdoc = compiled;
               }
          }
      });
  }, [state.nodes, state.connections, state.runningPreviewIds]);


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
    dispatch({ type: 'ADD_NODE', payload: newNode });
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
           dispatch({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: true } });
           dispatch({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
      } else {
           dispatch({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: false } });
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

  // --- AI Chat Logic ---

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
      dispatch({ 
          type: 'UPDATE_CONTEXT_NODES', 
          payload: { 
              id: state.selectionMode.requestingNodeId, 
              nodeIds: state.selectionMode.selectedIds 
          } 
      });
      dispatch({ type: 'SET_SELECTION_MODE', payload: { isActive: false } });
  };

  const handleSendMessage = async (nodeId: string, text: string) => {
      // 1. Add user message
      dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
      dispatch({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

      // 2. Prepare Context
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;

      const contextFiles = (node.contextNodeIds || [])
          .map(id => state.nodes.find(n => n.id === id))
          .filter(n => n && n.type === 'CODE');

      const fileContext = contextFiles.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');

      const systemInstruction = `You are an expert coding assistant in NodeCode Studio. 
      You are concise in conversation but thorough in coding.
      You have access to the user's files ONLY IF they have been selected in the context.
      
      Current Context Files:
      ${contextFiles.length > 0 ? contextFiles.map(f => f?.title).join(', ') : 'No files selected.'}

      Important Rules:
      1. If the user asks you to edit code but NO files are selected, politely ask them to "Select files using the + button" first.
      2. When asked to code, ALWAYS check if you should edit an existing file.
      3. To edit a file, you MUST use the 'updateFile' tool.
      4. The 'updateFile' tool requires the FULL content of the file.
      5. Do not reduce code size or functionality unless explicitly asked to optimize.
      6. Provide a text explanation of what you did alongside the tool call.
      `;

      try {
          const apiKey = process.env.API_KEY; 
          if (!apiKey) {
              dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: 'Error: API Key not found.' } } });
              dispatch({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
              return;
          }

          const ai = new GoogleGenAI({ apiKey });
          const fullPrompt = `User Query: ${text}\n\nContext Files Content:\n${fileContext}`;

          // Create an empty placeholder message for streaming
          dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });

          // Stream Response
          const result = await ai.models.generateContentStream({
              model: 'gemini-flash-lite-latest',
              contents: fullPrompt,
              config: {
                  systemInstruction,
                  tools: [{ functionDeclarations: [updateCodeFunction] }]
              }
          });

          let fullText = '';
          const functionCalls: any[] = [];

          for await (const chunk of result) {
              // Accumulate text
              const chunkText = chunk.text; // Fixed: Removed () as text is a property
              if (chunkText) {
                  fullText += chunkText;
                  dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
              }
              
              // Accumulate function calls
              if (chunk.functionCalls) {
                  functionCalls.push(...chunk.functionCalls);
              }
          }

          // Handle Function Calls (Tool Execution)
          let toolOutputText = '';
          if (functionCalls.length > 0) {
              // For robustness, sometimes the model duplicates tool calls in stream, 
              // but usually the SDK handles this. We will execute unique calls.
              for (const call of functionCalls) {
                  if (call.name === 'updateFile') {
                      const args = call.args as { filename: string, code: string };
                      const targetNode = state.nodes.find(n => n.type === 'CODE' && n.title === args.filename);
                      
                      if (targetNode) {
                          dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: targetNode.id, content: args.code } });
                          toolOutputText += `\n[Updated ${args.filename}]`;
                          // Visual flash for the update
                          handleHighlightNode(targetNode.id);
                      } else {
                          toolOutputText += `\n[Error: Could not find file ${args.filename}]`;
                      }
                  }
              }
              // Append tool status to the message
              if (toolOutputText) {
                  fullText += toolOutputText;
                  dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
              }
          }

      } catch (error: any) {
          console.error(error);
          dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${error.message}` } } });
      } finally {
          dispatch({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
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
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
        setIsPanning(false);
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    }

    if (!dragWire) return;
    
    const targetEl = document.elementFromPoint(e.clientX, e.clientY);
    const portEl = targetEl?.closest('[data-port-id]');
    
    if (portEl) {
        const endPortId = portEl.getAttribute('data-port-id');
        const endNodeId = portEl.getAttribute('data-node-id');

        if (endPortId && endNodeId && endPortId !== dragWire.startPortId) {
            const isStartInput = dragWire.isInput;
            const isTargetInput = endPortId.includes('-in-');
            
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

  const handleTouchStart = (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
          isPinching.current = true;
          setIsPanning(false); 
          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchDist.current = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
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
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
      if (e.touches.length < 2) {
          isPinching.current = false;
          lastTouchDist.current = null;
      }
  };


  const isConnected = (portId: string) => {
      return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
  };

  return (
    <div 
      className="w-screen h-screen bg-canvas overflow-hidden flex flex-col text-zinc-100 font-sans select-none touch-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="absolute top-4 left-4 z-50 pointer-events-none select-none flex items-center gap-3">
        <div>
            <h1 className="text-xl font-bold tracking-tight text-white drop-shadow-md">NodeCode Studio</h1>
            <p className="text-xs text-zinc-500">Drag ports to connect. Right-click connected ports to disconnect.</p>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900/80 border border-zinc-800 rounded-full backdrop-blur-sm pointer-events-auto" title="Cloud Sync Status">
            {syncStatus === 'synced' && <Cloud size={14} className="text-emerald-500" />}
            {syncStatus === 'saving' && <CloudUpload size={14} className="text-amber-500 animate-pulse" />}
            {syncStatus === 'offline' && <CloudOff size={14} className="text-zinc-500" />}
            {syncStatus === 'error' && <CloudOff size={14} className="text-red-500" />}
            <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400">
                {syncStatus === 'synced' ? 'Saved' : syncStatus === 'saving' ? 'Saving...' : 'Offline'}
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
                                isHighlighted={node.id === highlightedNodeId}
                                isRunning={state.runningPreviewIds.includes(node.id)}
                                scale={state.zoom}
                                isConnected={isConnected}
                                onMove={(id, pos) => dispatch({ type: 'UPDATE_NODE_POSITION', payload: { id, position: pos } })}
                                onResize={(id, size) => dispatch({ type: 'UPDATE_NODE_SIZE', payload: { id, size } })}
                                onDelete={(id) => dispatch({ type: 'DELETE_NODE', payload: id })}
                                onToggleRun={handleToggleRun}
                                onRefresh={handleRefresh}
                                onPortDown={handlePortDown}
                                onPortContextMenu={handlePortContextMenu}
                                onUpdateTitle={(id, title) => dispatch({ type: 'UPDATE_NODE_TITLE', payload: { id, title } })}
                                onSendMessage={handleSendMessage}
                                onStartContextSelection={handleStartContextSelection}
                                logs={logs}
                            >
                                {(node.type === 'CODE') && (
                                    <div className="pointer-events-auto cursor-text select-text h-full">
                                        <Editor
                                            value={node.content}
                                            onValueChange={code => dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: node.id, content: code } })}
                                            highlight={code => Prism.highlight(code, getHighlightLanguage(node.title), 'javascript')}
                                            padding={12}
                                            style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 13, lineHeight: '1.5', minHeight: '100%' }}
                                            className="min-h-full"
                                            textareaClassName="focus:outline-none whitespace-pre"
                                        />
                                    </div>
                                )}
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