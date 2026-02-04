
export type NodeType = 'CODE' | 'PREVIEW' | 'TERMINAL' | 'AI_CHAT' | 'NPM';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface NodeData {
  id: string;
  type: NodeType;
  title: string;
  position: Position;
  size: Size;
  content: string; // Code content, internal state, or NPM search query
  lastOutput?: any; // For terminals or previews to store runtime state if needed
  autoHeight?: boolean; // For CODE nodes to grow automatically
  messages?: ChatMessage[]; // For AI_CHAT nodes
  contextNodeIds?: string[]; // IDs of files selected for AI context
  isLoading?: boolean; // For AI loading state
  sharedState?: any; // For multiplayer state synchronization
}

export interface Port {
  id: string;
  nodeId: string;
  type: 'input' | 'output';
  label: string;
  accepts?: NodeType[]; // What kind of nodes can connect here
}

export interface Connection {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
}

export interface LogEntry {
  type: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
}

export interface UserPresence {
  id: string;
  x: number;
  y: number;
  color: string;
  lastActive: number;
  draggingNodeId?: string;
  draggingPosition?: Position;
  editingNodeId?: string;
}

export interface GraphState {
  nodes: NodeData[];
  connections: Connection[];
  pan: Position;
  zoom: number;
  logs: Record<string, LogEntry[]>; // Maps Preview Node ID to logs
  runningPreviewIds: string[]; // Track which previews are active for live updates
  selectionMode?: {
    isActive: boolean;
    requestingNodeId: string;
    selectedIds: string[];
  };
  collaborators: UserPresence[];
  nodeInteractions: Record<string, 'drag' | 'edit' | null>; // Local interaction locks
}

export type Action =
  | { type: 'ADD_NODE'; payload: NodeData }
  | { type: 'DELETE_NODE'; payload: string }
  | { type: 'UPDATE_NODE_POSITION'; payload: { id: string; position: Position } }
  | { type: 'UPDATE_NODE_SIZE'; payload: { id: string; size: Size } }
  | { type: 'UPDATE_NODE_CONTENT'; payload: { id: string; content: string } }
  | { type: 'UPDATE_NODE_TITLE'; payload: { id: string; title: string } }
  | { type: 'ADD_MESSAGE'; payload: { id: string; message: ChatMessage } }
  | { type: 'UPDATE_LAST_MESSAGE'; payload: { id: string; text: string } }
  | { type: 'SET_NODE_LOADING'; payload: { id: string; isLoading: boolean } }
  | { type: 'UPDATE_CONTEXT_NODES'; payload: { id: string; nodeIds: string[] } }
  | { type: 'SET_SELECTION_MODE'; payload: { isActive: boolean; requestingNodeId?: string; selectedIds?: string[] } }
  | { type: 'CONNECT'; payload: Connection }
  | { type: 'DISCONNECT'; payload: string } // Connection ID
  | { type: 'PAN'; payload: Position }
  | { type: 'ZOOM'; payload: { zoom: number; center?: Position } }
  | { type: 'ADD_LOG'; payload: { nodeId: string; log: LogEntry } }
  | { type: 'CLEAR_LOGS'; payload: { nodeId: string } }
  | { type: 'TOGGLE_PREVIEW'; payload: { nodeId: string; isRunning: boolean } }
  | { type: 'LOAD_STATE'; payload: Partial<GraphState> }
  | { type: 'UPDATE_COLLABORATORS'; payload: UserPresence[] }
  | { type: 'SET_NODE_INTERACTION'; payload: { nodeId: string; type: 'drag' | 'edit' | null } }
  | { type: 'UPDATE_NODE_SHARED_STATE'; payload: { nodeId: string; state: any } };
