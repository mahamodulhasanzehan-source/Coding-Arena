import { GraphState, Action, NodeData } from '../types';
import { NODE_DEFAULTS } from '../constants';

export const initialState: GraphState = {
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

export function graphReducer(state: GraphState, action: Action): GraphState {
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
                        return {
                            ...n,
                            isMinimized: false,
                            size: n.expandedSize || NODE_DEFAULTS.CODE,
                            autoHeight: n.expandedSize ? n.autoHeight : true
                        };
                    } else {
                        const minWidth = Math.min(400, Math.max(160, n.title.length * 9 + 120));
                        return {
                            ...n,
                            isMinimized: true,
                            expandedSize: n.size,
                            size: { width: minWidth, height: 40 }
                        };
                    }
                })
            };
        default:
            return state;
    }
}