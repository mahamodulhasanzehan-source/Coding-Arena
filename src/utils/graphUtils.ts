
import { Connection, NodeData, NodeType, Port } from '../types';
import { getPortsForNode } from '../constants';

// ---- Port Calculation Math ----
const HEADER_HEIGHT = 40; 
const PORT_START_Y = 52;  
const PORT_STRIDE = 40; 
const PORT_OFFSET_X = 12; 

export const calculatePortPosition = (
  node: NodeData,
  portId: string,
  type: 'input' | 'output'
) => {
  const ports = getPortsForNode(node.id, node.type);
  const relevantPorts = ports.filter(p => p.type === type);
  const portIndex = relevantPorts.findIndex(p => p.id === portId);

  if (portIndex === -1) return { x: node.position.x, y: node.position.y };

  const yRelative = PORT_START_Y + 6 + (portIndex * PORT_STRIDE);
  const y = node.position.y + yRelative;

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

// Helper to recursively collect all code dependencies
const collectDependencies = (
  rootNode: NodeData,
  nodes: NodeData[],
  connections: Connection[],
  visited: Set<string> = new Set()
): NodeData[] => {
    if (visited.has(rootNode.id)) return [];
    visited.add(rootNode.id);

    const directDeps = getAllConnectedSources(rootNode.id, 'file', nodes, connections);
    let allDeps: NodeData[] = [...directDeps];

    directDeps.forEach(dep => {
        const nestedDeps = collectDependencies(dep, nodes, connections, visited);
        allDeps = [...allDeps, ...nestedDeps];
    });

    return allDeps;
};

export const compilePreview = (
  previewNodeId: string,
  nodes: NodeData[],
  connections: Connection[],
  forceReload: boolean = false
): string => {
  // 1. Find the main entry point connected to PREVIEW
  const rootNode = getConnectedSource(previewNodeId, 'dom', nodes, connections);
  
  if (!rootNode) {
    return `
      <!DOCTYPE html>
      <html>
        <body style="background-color: #0f0f11; color: #71717a; font-family: sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0;">
          <div style="text-align: center;">
            <p>Connect a <strong>CODE Canvas</strong> to the DOM port.</p>
          </div>
        </body>
      </html>
    `;
  }

  // 2. Resolve Dependencies (Wired nodes only, recursively)
  const dependencyNodes = collectDependencies(rootNode, nodes, connections);
  
  // Remove duplicates just in case
  const uniqueDeps = Array.from(new Set(dependencyNodes.map(n => n.id)))
      .map(id => nodes.find(n => n.id === id)!)
      .filter(n => n.id !== rootNode.id); 

  let finalContent = rootNode.content;
  const connectedFilenames = new Set(uniqueDeps.map(d => d.title));
  const missingDependencies: string[] = [];

  // Wrap content based on STRICT file extension
  const lowerTitle = rootNode.title.toLowerCase();
  
  if (lowerTitle.endsWith('.html') || lowerTitle.endsWith('.htm')) {
      // HTML: Render as is
  } else if (lowerTitle.endsWith('.js') || lowerTitle.endsWith('.ts')) {
      // JS: Wrap in script
      finalContent = `<script>\n${finalContent}\n</script>`;
  } else if (lowerTitle.endsWith('.css')) {
      // CSS: Wrap in style
      finalContent = `<style>\n${finalContent}\n</style>`;
  } else {
      // Everything else (txt, md, no extension): Render as plain text
      const escaped = finalContent
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
          
      finalContent = `
        <body style="margin: 0; background-color: #1e1e1e; color: #d4d4d4;">
            <pre style="padding: 1rem; font-family: 'JetBrains Mono', monospace; white-space: pre-wrap; word-wrap: break-word;">${escaped}</pre>
        </body>
      `;
  }

  // 3. Inject Dependencies based on Filenames (Only if the root is HTML-like)
  if (lowerTitle.endsWith('.html') || lowerTitle.endsWith('.htm')) {
      // Check CSS imports <link href="style.css">
      finalContent = finalContent.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (match, filename) => {
        const depNode = uniqueDeps.find(d => d.title === filename);
        if (depNode) {
            return `<style>\n/* Source: ${filename} */\n${depNode.content}\n</style>`;
        } else {
            missingDependencies.push(filename);
            return match; 
        }
      });

      // Check JS imports <script src="script.js">
      finalContent = finalContent.replace(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi, (match, filename) => {
        const depNode = uniqueDeps.find(d => d.title === filename);
        if (depNode) {
            return `<script>\n/* Source: ${filename} */\n${depNode.content}\n</script>`;
        } else {
            missingDependencies.push(filename);
            return match; 
        }
      });
  }


  // 4. Inject Console Interceptor & Multiplayer Bridge & Force Reload Timestamp
  const errorInjections = missingDependencies.map(file => 
    `console.error('Dependency Error: "${file}" is referenced in code but not connected via wires.');`
  ).join('\n');

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
             // Ignore serialization errors
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

        // --- Multiplayer Bridge ---
        window.broadcastState = function(state) {
          window.parent.postMessage({
            source: 'preview-iframe',
            nodeId: '${previewNodeId}',
            type: 'BROADCAST_STATE',
            payload: state
          }, '*');
        };

        window.onStateReceived = function(callback) {
          window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'STATE_UPDATE') {
              callback(event.data.payload);
            }
          });
        };

        // Report Missing Dependencies immediately
        ${errorInjections}
      })();
    </script>
    ${forceReload ? `<!-- Force Reload: ${Date.now()} -->` : ''}
  `;

  // Only inject interceptor into HTML pages
  if (lowerTitle.endsWith('.html') || lowerTitle.endsWith('.htm')) {
       return `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            ${interceptor}
          </head>
          <body>
            ${finalContent}
          </body>
        </html>
      `;
  } else {
      if (lowerTitle.endsWith('.js') || lowerTitle.endsWith('.css')) {
           return `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8">${interceptor}</head>
            <body>${finalContent}</body>
            </html>
           `;
      }
      return finalContent;
  }
};
