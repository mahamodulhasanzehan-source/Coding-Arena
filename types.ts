export type NodeType = 'CODE' | 'PREVIEW' | 'TERMINAL';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface NodeData {
  id: string;
  type: NodeType;
  title: string;
  position: Position;
  size: Size;
  content: string; // Code content or internal state
  lastOutput?: any; // For terminals or previews to store runtime state if needed
}

export interface Port {
  id: string;
  nodeId: string;
  type: 'input' | 'output';
  label: string;
  accepts?: NodeType[]; // What kind of nodes can connect here (e.g., Preview accepts HTML)
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

export interface GraphState {
  nodes: NodeData[];
  connections: Connection[];
  pan: Position;
  zoom: number;
  logs: Record<string, LogEntry[]>; // Maps Preview Node ID to logs
}

export type Action =
  | { type: 'ADD_NODE'; payload: NodeData }
  | { type: 'DELETE_NODE'; payload: string }
  | { type: 'UPDATE_NODE_POSITION'; payload: { id: string; position: Position } }
  | { type: 'UPDATE_NODE_SIZE'; payload: { id: string; size: Size } }
  | { type: 'UPDATE_NODE_CONTENT'; payload: { id: string; content: string } }
  | { type: 'UPDATE_NODE_TITLE'; payload: { id: string; title: string } }
  | { type: 'CONNECT'; payload: Connection }
  | { type: 'DISCONNECT'; payload: string } // Connection ID
  | { type: 'PAN'; payload: Position }
  | { type: 'ZOOM'; payload: { zoom: number; center?: Position } }
  | { type: 'ADD_LOG'; payload: { nodeId: string; log: LogEntry } }
  | { type: 'CLEAR_LOGS'; payload: { nodeId: string } }
  | { type: 'LOAD_STATE'; payload: Partial<GraphState> };