
import React, { useReducer, useState, useRef, useEffect, useMemo } from 'react';
import { Node } from './components/Node';
import { Wire } from './components/Wire';
import { ContextMenu } from './components/ContextMenu';
import { Sidebar } from './components/Sidebar';
import { CollaboratorCursor } from './components/CollaboratorCursor';
import { GraphState, Action, NodeData, NodeType, LogEntry, UserPresence } from './types';
import { NODE_DEFAULTS } from './constants';
import { compilePreview, calculatePortPosition } from './utils/graphUtils';
import { Trash2, Menu, Cloud, CloudOff, CloudUpload, Plus, Minus, Search, Download } from 'lucide-react';
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { signIn, db } from './firebase';
import { doc, getDoc, setDoc, onSnapshot, collection, deleteDoc } from 'firebase/firestore';
import JSZip from 'jszip';
import { loader } from '@monaco-editor/react';

// --- FIX: Configure Monaco Loader to use stable CDN for workers ---
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.46.0/min/vs',
  },
});

// Define SyncStatus
type SyncStatus = 'synced' | 'saving' | 'offline' | 'error';

// Define getRandomColor
const getRandomColor = () => {
  const colors = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'];
  return colors[Math.floor(Math.random() * colors.length)];
};

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
        case 'CONNECT': {
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
        }
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
            const id = action.payload;
            return {
                ...state,
                nodes: state.nodes.map(n => {
                    if (n.id !== id) return n;
                    if (n.isMinimized) {
                        // Expand: Restore size
                        return {
                            ...n,
                            isMinimized: false,
                            size: n.expandedSize || NODE_DEFAULTS.CODE,
                            // If it was autoHeight before, keep it, otherwise restore
                            autoHeight: n.expandedSize ? n.autoHeight : true
                        };
                    } else {
                        // Minimize: Calculate reduced width based on title
                        // Approx 9px per char + 120px for icons/padding
                        const minWidth = Math.min(400, Math.max(160, n.title.length * 9 + 120));
                        return {
                            ...n,
                            isMinimized: true,
                            expandedSize: n.size, // Save current size
                            size: { width: minWidth, height: 40 } // Set fixed minimized size
                        };
                    }
                })
            };
        default:
            return state;
    }
}

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
    
    // For mouse presence throttling
    const throttleRef = useRef(0);

    const dispatchLocal = (action: Action) => {
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

    // Firebase Init
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
                            dispatch({
                                type: 'LOAD_STATE',
                                payload: loadedState
                            });
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

                // Presence Logic
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

                // Set initial presence
                const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
                await setDoc(myPresenceRef, {
                    id: sessionId,
                    x: 0,
                    y: 0,
                    color: userColor,
                    lastActive: Date.now()
                });

            } catch (e) {
                console.error(e);
                setSyncStatus('error');
            }
        };

        init();

        return () => {
             // Cleanup handled by disconnect typically, but for hot reload we try
             deleteDoc(doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId)).catch(() => {});
        }
    }, [sessionId, userColor]);

    // Presence Update Loop (Mouse Position)
    useEffect(() => {
        const interval = setInterval(() => {
            if (userUid) {
                 const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
                 // We don't have direct mouse position here without state, so we just heartbeat
                 // Actual position updates happen in pointer move
                 setDoc(myPresenceRef, { lastActive: Date.now() }, { merge: true }).catch(() => {});
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [userUid, sessionId]);

    // Sync Changes Debounce
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
                        pan: { x: 0, y: 0 }, zoom: 1 // Don't sync view state
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

    // Live Preview Compilation
    useEffect(() => {
        state.runningPreviewIds.forEach(previewId => {
            const iframe = document.getElementById(`preview-iframe-${previewId}`) as HTMLIFrameElement;
            if (iframe) {
                const compiled = compilePreview(previewId, state.nodes, state.connections, false);
                if (iframe.srcdoc !== compiled) iframe.srcdoc = compiled;
            }
        });
    }, [state.nodes, state.connections, state.runningPreviewIds]);

    // Message Listener
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
            autoHeight: type === 'CODE' ? false : undefined,
        };
        dispatchLocal({ type: 'ADD_NODE', payload: newNode });
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
            dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
        } else {
            dispatchLocal({ type: 'TOGGLE_PREVIEW', payload: { nodeId: id, isRunning: false } });
            dispatchLocal({ type: 'CLEAR_LOGS', payload: { nodeId: id } });
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

    // AI Chat & Generation
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

    const handleCancelAi = (nodeId: string) => {
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
    };

    const handleSendMessage = async (nodeId: string, text: string) => {
        dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

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
                dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: 'Error: API Key not found.' } } });
                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
                return;
            }

            const ai = new GoogleGenAI({ apiKey });
            const fullPrompt = `User Query: ${text}\n\nContext Files Content:\n${fileContext}`;

            dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });

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
                const chunkText = chunk.text;
                if (chunkText) {
                    fullText += chunkText;
                    dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
                if (chunk.functionCalls) {
                    functionCalls.push(...chunk.functionCalls);
                }
            }

            let toolOutputText = '';
            if (functionCalls.length > 0) {
                for (const call of functionCalls) {
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
                    dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
            }

        } catch (error: any) {
            console.error(error);
            dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${error.message}` } } });
        } finally {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
        }
    };

    const handleFixError = async (nodeId: string, errorMsg: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if(!node) return;

        // Find connected preview, then find connected source
        const connectionsToTerminal = state.connections.filter(c => c.targetNodeId === nodeId);
        if (connectionsToTerminal.length === 0) return;

        // Just take the first preview connected
        const previewNodeId = connectionsToTerminal[0].sourceNodeId;
        const connectionsToPreview = state.connections.filter(c => c.targetNodeId === previewNodeId);
        
        // Find sources
        const sources = connectionsToPreview.map(c => state.nodes.find(n => n.id === c.sourceNodeId)).filter(n => n && n.type === 'CODE');
        
        if (sources.length === 0) return;

        const fileContext = sources.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');
        
        // Use a chat node to display the fix or create one? 
        // For simplicity, we'll try to update the code directly or use an existing chat node.
        // Let's create a temporary prompt in the background using the same AI logic.

        // We'll highlight the source file that likely has the error
        sources.forEach(s => handleHighlightNode(s!.id));

        const apiKey = process.env.API_KEY;
        if (!apiKey) return;

        const ai = new GoogleGenAI({ apiKey });
        const systemInstruction = `You are an automated error fixer.
        Analyze the error message and the provided code.
        Use 'updateFile' to fix the error in the appropriate file.
        If you cannot fix it, do nothing.
        `;

        const prompt = `Error Message: ${errorMsg}\n\nFiles:\n${fileContext}\n\nFix the error using the updateFile tool.`;
        
        try {
             const response = await ai.models.generateContent({
                 model: 'gemini-flash-lite-latest',
                 contents: prompt,
                 config: { systemInstruction, tools: [{ functionDeclarations: [updateCodeFunction] }] }
             });

             const calls = response.functionCalls;
             if (calls) {
                 for (const call of calls) {
                     if (call.name === 'updateFile') {
                        const args = call.args as { filename: string, code: string };
                        const target = state.nodes.find(n => n.title === args.filename && n.type === 'CODE');
                        if (target) {
                            dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } });
                            handleHighlightNode(target.id);
                        }
                     }
                 }
             }
        } catch (e) { console.error(e); }
    };


    const handleAiGenerate = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node || node.type !== 'CODE') return;

        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

        try {
            const apiKey = process.env.API_KEY;
            if (!apiKey) {
                alert('API Key not found.');
                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
                return;
            }

            const ai = new GoogleGenAI({ apiKey });

            let systemInstruction = '';
            let userPrompt = '';

            if (action === 'optimize') {
                systemInstruction = `You are an expert developer. 
              Your task is to OPTIMIZE the provided code for performance, readability, and best practices. 
              RULES:
              1. Remove pointless or redundant code.
              2. Do NOT minify the code.
              3. Do NOT reduce code size just for the sake of it; only remove dead logic.
              4. Maintain all existing functionality.
              5. Return ONLY the full optimized code as plain text.`;
                userPrompt = `Please optimize the following code:\n\n${node.content}`;
            } else {
                systemInstruction = `You are an expert developer.
              Your task is to MODIFY the provided code based on the user's request.
              RULES:
              1. Return ONLY the full modified code as plain text.
              2. Maintain existing functionality unless asked to change it.`;
                userPrompt = `User Request: ${promptText}\n\nCurrent Code:\n${node.content}`;
            }

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: userPrompt,
                config: { systemInstruction }
            });

            const rawText = response.text;

            if (rawText) {
                const cleanCode = rawText.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');
                dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: cleanCode } });
                handleHighlightNode(nodeId);
            }

        } catch (error: any) {
            console.error("AI Generation Error:", error);
            alert(`AI Error: ${error.message}`);
        } finally {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
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
        // Send mouse presence
        const now = Date.now();
        if (now - throttleRef.current > 50 && containerRef.current && userUid) {
            throttleRef.current = now;
            const rect = containerRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const worldX = (mouseX - state.pan.x) / state.zoom;
            const worldY = (mouseY - state.pan.y) / state.zoom;

            const myPresenceRef = doc(db, 'nodecode_projects', 'global_project_room', 'presence', sessionId);
            // We just update locally invoked via firestore
            setDoc(myPresenceRef, { x: worldX, y: worldY, lastActive: now, color: userColor }, { merge: true }).catch(() => {});
        }

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
    };

    // Touch handlers for pinch zoom
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

    const handleClearImage = (id: string) => {
        dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id, content: '' } });
        setContextMenu(null);
    };

    const isConnected = (portId: string) => {
        return state.connections.some(c => c.sourcePortId === portId || c.targetPortId === portId);
    };

    const handleZoomIn = () => {
        const newZoom = Math.min(state.zoom + 0.1, 3);
        const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        
        // Adjust pan to zoom towards center
        const worldX = (center.x - state.pan.x) / state.zoom;
        const worldY = (center.y - state.pan.y) / state.zoom;
        const newPanX = center.x - worldX * newZoom;
        const newPanY = center.y - worldY * newZoom;

        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    };

    const handleZoomOut = () => {
        const newZoom = Math.max(state.zoom - 0.1, 0.1);
        const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        
        // Adjust pan to zoom towards center
        const worldX = (center.x - state.pan.x) / state.zoom;
        const worldY = (center.y - state.pan.y) / state.zoom;
        const newPanX = center.x - worldX * newZoom;
        const newPanY = center.y - worldY * newZoom;

        dispatch({ type: 'ZOOM', payload: { zoom: newZoom } });
        dispatch({ type: 'PAN', payload: { x: newPanX, y: newPanY } });
    };

    const animateCamera = (targetX: number, targetY: number) => {
        const startX = state.pan.x;
        const startY = state.pan.y;
        const startTime = performance.now();
        const duration = 600; // ms

        const animate = (currentTime: number) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Ease out cubic
            const ease = 1 - Math.pow(1 - progress, 3);

            const currentX = startX + (targetX - startX) * ease;
            const currentY = startY + (targetY - startY) * ease;

            dispatch({ type: 'PAN', payload: { x: currentX, y: currentY } });

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };
        requestAnimationFrame(animate);
    };

    const handleFindNearest = () => {
        if (state.nodes.length === 0) {
            dispatch({ type: 'PAN', payload: { x: 0, y: 0 } });
            dispatch({ type: 'ZOOM', payload: { zoom: 1 } });
            return;
        }

        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        
        // Current center of viewport in world coordinates
        const centerX = (viewportW / 2 - state.pan.x) / state.zoom;
        const centerY = (viewportH / 2 - state.pan.y) / state.zoom;

        // Find closest node
        let closestNode = state.nodes[0];
        let minDist = Infinity;

        state.nodes.forEach(node => {
            const nx = node.position.x + node.size.width / 2;
            const ny = node.position.y + node.size.height / 2;
            const dist = Math.hypot(nx - centerX, ny - centerY);
            if (dist < minDist) {
                minDist = dist;
                closestNode = node;
            }
        });

        const nodeCx = closestNode.position.x + closestNode.size.width / 2;
        const nodeCy = closestNode.position.y + closestNode.size.height / 2;
        
        // Calculate target Pan to center this node
        const newPanX = (viewportW / 2) - nodeCx * state.zoom;
        const newPanY = (viewportH / 2) - nodeCy * state.zoom;
        
        // Animate
        animateCamera(newPanX, newPanY);
        
        // Highlight
        handleHighlightNode(closestNode.id);
    };

    const handleDownloadZip = async () => {
        const zip = new JSZip();
        const codeNodes = state.nodes.filter(n => n.type === 'CODE');
        
        if (codeNodes.length === 0) {
            alert("No code modules to download.");
            return;
        }

        // Build adjacency list for connectivity check
        const adj = new Map<string, string[]>();
        state.nodes.forEach(n => adj.set(n.id, []));
        state.connections.forEach(c => {
            if (!adj.has(c.sourceNodeId)) adj.set(c.sourceNodeId, []);
            if (!adj.has(c.targetNodeId)) adj.set(c.targetNodeId, []);
            adj.get(c.sourceNodeId)?.push(c.targetNodeId);
            adj.get(c.targetNodeId)?.push(c.sourceNodeId);
        });

        const visited = new Set<string>();
        
        for (const node of codeNodes) {
            if (visited.has(node.id)) continue;

            // Find Connected Component
            const component: NodeData[] = [];
            const queue = [node.id];
            visited.add(node.id);
            
            // We want to verify if this group has ANY connections (wires).
            // A node is "connected" if it has > 0 edges in the graph, even if it's size 1 connected to a non-code node.
            let hasWires = (adj.get(node.id)?.length || 0) > 0;

            while(queue.length > 0) {
                const currId = queue.shift()!;
                const currNode = state.nodes.find(n => n.id === currId);
                
                if (currNode && currNode.type === 'CODE') {
                    component.push(currNode);
                }
                
                if ((adj.get(currId)?.length || 0) > 0) {
                    hasWires = true; 
                }

                const neighbors = adj.get(currId) || [];
                for (const neighborId of neighbors) {
                    if (!visited.has(neighborId)) {
                        visited.add(neighborId);
                        queue.push(neighborId);
                    }
                }
            }

            if (component.length > 0) {
                // Decision: Folder or Root?
                // Rule: "connected via wires... separate folder"
                // Rule: "not connected... thrown into zip"
                
                if (hasWires) {
                    const folderName = `project-${Math.random().toString(36).substr(2, 6)}`;
                    const folder = zip.folder(folderName);
                    component.forEach(n => folder?.file(n.title, n.content));
                } else {
                    // Isolated nodes
                    component.forEach(n => zip.file(n.title, n.content));
                }
            }
        }

        const content = await zip.generateAsync({ type: "blob" });
        const url = window.URL.createObjectURL(content);
        const a = document.createElement("a");
        a.href = url;
        a.download = "nodecode-project.zip";
        a.click();
        window.URL.revokeObjectURL(url);
    };

    const handleReset = () => {
        const pwd = prompt("Enter password to reset:");
        if (pwd === 'password') {
            localStorage.removeItem('nodecode-studio-v1');
            window.location.reload();
        } else if (pwd !== null) {
            alert("Incorrect password");
        }
    };

    // Memoize display nodes to inject remote dragging/editing visualizations
    const displayNodes = useMemo(() => {
        return state.nodes.map(node => {
            const collaborator = state.collaborators.find(c => c.draggingNodeId === node.id && c.id !== sessionId);
            if (collaborator && collaborator.draggingPosition) {
                return { ...node, position: collaborator.draggingPosition };
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
                    {syncStatus === 'saving' && <CloudUpload size={14} className="text-amber-500 animate-pulse" />}
                    {syncStatus === 'offline' && <CloudOff size={14} className="text-zinc-500" />}
                    {syncStatus === 'error' && <CloudOff size={14} className="text-red-500" />}
                    <span className="text-[10px] uppercase font-bold tracking-wider text-zinc-400">
                        {syncStatus === 'synced' ? 'Saved' : syncStatus === 'saving' ? 'Saving...' : 'Offline'}
                    </span>
                </div>
            </div>

            <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 items-end">
                {/* Desktop Buttons (Hidden on mobile) */}
                <button
                    onClick={handleReset}
                    className="hidden md:flex px-3 py-1.5 bg-zinc-900/80 hover:bg-red-900/50 text-xs text-zinc-400 border border-zinc-800 rounded items-center gap-2 transition-colors pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <Trash2 size={12} /> Reset
                </button>
                
                {/* Menu Button (Visible on both) */}
                <button
                    onClick={() => setIsSidebarOpen(true)}
                    className="px-3 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
                    onPointerDown={(e) => e.stopPropagation()}
                >
                    <Menu size={16} />
                </button>
                
                <div className="flex flex-col gap-1 mt-2">
                     {/* Mobile Only: Zoom In/Out */}
                    <button
                        onClick={handleZoomIn}
                        className="md:hidden px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Zoom In"
                    >
                        <Plus size={16} />
                    </button>
                    <button
                        onClick={handleZoomOut}
                        className="md:hidden px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Zoom Out"
                    >
                        <Minus size={16} />
                    </button>

                    {/* Find Nearest (Visible on both) */}
                    <button
                        onClick={handleFindNearest}
                        className="px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded flex items-center justify-center transition-colors pointer-events-auto cursor-pointer"
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Find Nearest Node"
                    >
                        <Search size={16} />
                    </button>

                    {/* Desktop Only: Download */}
                    <button
                        onClick={handleDownloadZip}
                        className="hidden md:flex px-2 py-2 bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800 rounded items-center justify-center transition-colors pointer-events-auto cursor-pointer"
                        onPointerDown={(e) => e.stopPropagation()}
                        title="Download Project (ZIP)"
                    >
                        <Download size={16} />
                    </button>
                </div>
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
                        {state.collaborators.map(user => (
                            <CollaboratorCursor key={user.id} x={user.x} y={user.y} color={user.color} name={''} />
                        ))}

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
                            const activeCollaborator = state.collaborators.find(c => (c.draggingNodeId === node.id || c.editingNodeId === node.id) && c.id !== sessionId);
                            const collabInfo = activeCollaborator ? { name: '', color: activeCollaborator.color, action: (activeCollaborator.editingNodeId === node.id ? 'editing' : 'dragging') as any } : undefined;

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
                                        onToggleMinimize={(id) => dispatchLocal({ type: 'TOGGLE_MINIMIZE', payload: id })}
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
