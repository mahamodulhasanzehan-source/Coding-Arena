import { Connection, NodeData, NodeType, Port } from '../types';
import { getPortsForNode } from '../constants';

// ---- Port Calculation Math ----
// These must match the CSS in Node.tsx exactly
const HEADER_HEIGHT = 40; // h-10
const PORT_START_Y = 52;  // top-[52px]
// The gap in CSS is gap-[28px]. Plus the height of the port itself (h-3 = 12px).
// So the stride is 12px + 28px = 40px. 
// Wait, CSS flex gap puts space BETWEEN items.
// Item height = 12px. Gap = 28px.
// 1st item at 0 (relative to container).
// 2nd item at 12 + 28 = 40.
// 3rd item at 40 + 40 = 80.
const PORT_STRIDE = 40; 
const PORT_OFFSET_X = 12; // -left-3 and -right-3 is -12px. Center of 12px dot is 6px. 
// Actually, visually we want the wire to start from the center of the dot.
// The dot is w-3 (12px). 
// Left inputs: left: -12px. Center x = -12 + 6 = -6. relative to node 0.
// Right outputs: right: -12px. Center x = Width + 12 - 6 = Width + 6.

export const calculatePortPosition = (
  node: NodeData,
  portId: string,
  type: 'input' | 'output'
) => {
  const ports = getPortsForNode(node.id, node.type);
  const relevantPorts = ports.filter(p => p.type === type);
  const portIndex = relevantPorts.findIndex(p => p.id === portId);

  if (portIndex === -1) return { x: node.position.x, y: node.position.y };

  // Calculate Y
  // The container starts at PORT_START_Y inside the node
  // Each port is centered vertically in its "slot" effectively, but the CSS is flex-col with gap.
  // Center of the first dot (12px high) is at 6px.
  const yRelative = PORT_START_Y + 6 + (portIndex * PORT_STRIDE);
  const y = node.position.y + yRelative;

  // Calculate X
  const x = type === 'input' 
    ? node.position.x - 6 
    : node.position.x + node.size.width + 6;

  return { x, y };
};

// ---- Graph Traversal Helpers ----

export const getConnectedSource = (
  targetNodeId: string,
  targetPortLabel: string,
  nodes: NodeData[],
  connections: Connection[]
): NodeData | undefined => {
  const connection = connections.find(c => {
    // Check if target matches and if the port ID string contains the label (e.g., "in-dom" contains "dom")
    return c.targetNodeId === targetNodeId && c.targetPortId.toLowerCase().includes(targetPortLabel.toLowerCase());
  });

  if (!connection) return undefined;
  return nodes.find(n => n.id === connection.sourceNodeId);
};

export const getAllConnectedSources = (
  targetNodeId: string,
  targetPortLabel: string,
  nodes: NodeData[],
  connections: Connection[]
): NodeData[] => {
    return connections
        .filter(c => c.targetNodeId === targetNodeId && c.targetPortId.toLowerCase().includes(targetPortLabel.toLowerCase()))
        .map(c => nodes.find(n => n.id === c.sourceNodeId))
        .filter((n): n is NodeData => !!n);
};

export const compilePreview = (
  previewNodeId: string,
  nodes: NodeData[],
  connections: Connection[]
): string => {
  // 1. Find the connected HTML node
  const htmlNode = getConnectedSource(previewNodeId, 'dom', nodes, connections);
  
  if (!htmlNode) {
    return `
      <!DOCTYPE html>
      <html>
        <body style="background-color: #0f0f11; color: #71717a; font-family: sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0;">
          <div style="text-align: center;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 16px; opacity: 0.5;">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            <p>Connect an <strong>HTML Canvas</strong> to the DOM port to see output.</p>
          </div>
        </body>
      </html>
    `;
  }

  // 2. Find CSS connected to that HTML node
  const cssNodes = getAllConnectedSources(htmlNode.id, 'css', nodes, connections);
  const cssContent = cssNodes.map(n => n.content).join('\n');

  // 3. Find JS connected to that HTML node
  const jsNodes = getAllConnectedSources(htmlNode.id, 'js', nodes, connections);
  const jsContent = jsNodes.map(n => `
    try {
      ${n.content}
    } catch(err) {
      console.error(err);
    }
  `).join('\n');

  // 4. Inject Console Interceptor
  const interceptor = `
    <script>
      (function() {
        const oldLog = console.log;
        const oldError = console.error;
        const oldWarn = console.warn;
        const oldInfo = console.info;

        function send(type, args) {
          try {
            const message = args.map(arg => {
                if (arg === undefined) return 'undefined';
                if (arg === null) return 'null';
                if (typeof arg === 'object') return JSON.stringify(arg);
                return String(arg);
            }).join(' ');
            
            window.parent.postMessage({
              source: 'preview-iframe',
              nodeId: '${previewNodeId}',
              type: type,
              message: message,
              timestamp: Date.now()
            }, '*');
          } catch (e) {
            window.parent.postMessage({
              source: 'preview-iframe',
              nodeId: '${previewNodeId}',
              type: 'error',
              message: 'Log Serialization Error: ' + e.message,
              timestamp: Date.now()
            }, '*');
          }
        }

        console.log = function(...args) { oldLog.apply(console, args); send('log', args); };
        console.error = function(...args) { oldError.apply(console, args); send('error', args); };
        console.warn = function(...args) { oldWarn.apply(console, args); send('warn', args); };
        console.info = function(...args) { oldInfo.apply(console, args); send('info', args); };
        
        window.onerror = function(msg, url, line, col, error) {
           send('error', [msg + ' (Line ' + line + ')']);
           return false;
        };
      })();
    </script>
  `;

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        ${interceptor}
        <style>
          /* Basic reset for preview */
          body { margin: 0; padding: 0; }
          ${cssContent}
        </style>
      </head>
      <body>
        ${htmlNode.content}
        <script>${jsContent}</script>
      </body>
    </html>
  `;
};
