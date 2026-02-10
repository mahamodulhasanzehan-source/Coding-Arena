
import { Connection, NodeData, NodeType, Port } from '../types';
import { getPortsForNode } from '../constants';

// ---- Port Calculation Math ----
const HEADER_HEIGHT = 40; 
const PORT_START_Y = 52;  
const PORT_STRIDE = 40; 
const PORT_OFFSET_X = 12; 

// FIX 1a: Correctly calculate port position when minimized
export const calculatePortPosition = (
  node: NodeData,
  portId: string,
  type: 'input' | 'output'
) => {
  const ports = getPortsForNode(node.id, node.type);
  const relevantPorts = ports.filter(p => p.type === type);
  const portIndex = relevantPorts.findIndex(p => p.id === portId);

  if (portIndex === -1) return { x: node.position.x, y: node.position.y };

  // When minimized, align with the center of the 40px header (approx 20px)
  const startY = node.isMinimized ? 20 : PORT_START_Y;
  // If minimized, we reduce stride or keep it. Keeping it ensures multiple ports don't overlap if they exist.
  // However, minimized nodes usually shouldn't have many ports visible or they should stack. 
  // For visual correctness, we keep the stride but start higher.
  const yRelative = startY + 6 + (portIndex * PORT_STRIDE);
  const y = node.position.y + yRelative;

  const width = node.size.width;

  const x = type === 'input' 
    ? node.position.x - 6 
    : node.position.x + width + 6;

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

// Added getRelatedNodes for AI context
export const getRelatedNodes = (
  startNodeId: string,
  nodes: NodeData[],
  connections: Connection[]
): NodeData[] => {
    const related = new Set<string>();
    const queue = [startNodeId];
    related.add(startNodeId);

    while (queue.length > 0) {
        const currentId = queue.shift()!;
        
        // Find neighbors (both input and output)
        const neighbors = connections
            .filter(c => c.sourceNodeId === currentId || c.targetNodeId === currentId)
            .map(c => c.sourceNodeId === currentId ? c.targetNodeId : c.sourceNodeId);
            
        for (const neighborId of neighbors) {
            if (!related.has(neighborId)) {
                related.add(neighborId);
                queue.push(neighborId);
            }
        }
    }
    
    return nodes.filter(n => related.has(n.id));
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
    // Also check for folder connections (Folder Module Support)
    const folderDeps = getAllConnectedSources(rootNode.id, 'files', nodes, connections); // Connection from folder to file
    
    let allDeps: NodeData[] = [...directDeps];

    // Identify if any direct dep is a FOLDER
    const folderNodes = directDeps.filter(d => d.type === 'FOLDER');
    if (folderNodes.length > 0) {
        // Collect children of these folders
        folderNodes.forEach(folder => {
             const children = connections
                .filter(c => c.targetNodeId === folder.id && c.targetPortId.includes('in-files'))
                .map(c => nodes.find(n => n.id === c.sourceNodeId))
                .filter((n): n is NodeData => !!n);
             allDeps.push(...children);
        });
    }

    // Recurse
    [...directDeps, ...folderDeps].forEach(dep => {
        const nestedDeps = collectDependencies(dep, nodes, connections, visited);
        allDeps = [...allDeps, ...nestedDeps];
    });

    return allDeps;
};

// FIX 4: Robust Preview Compilation with Blobs
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

  // 2. Resolve Dependencies
  const dependencyNodes = collectDependencies(rootNode, nodes, connections);
  
  // Filter unique and self
  const uniqueDeps = Array.from(new Set(dependencyNodes.map(n => n.id)))
      .map(id => nodes.find(n => n.id === id)!)
      .filter(n => n.id !== rootNode.id); 

  // 3. Create Blobs for Dependencies
  // This ensures external scripts/css load correctly with attributes (defer/module) preserved
  const blobs: Record<string, string> = {};
  
  uniqueDeps.forEach(dep => {
      let mimeType = 'text/javascript';
      if (dep.title.endsWith('.css')) mimeType = 'text/css';
      else if (dep.title.endsWith('.json')) mimeType = 'application/json';
      else if (dep.title.endsWith('.html')) mimeType = 'text/html';
      
      const blob = new Blob([dep.content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      blobs[dep.title] = url;
      // Also register sans-extension for module resolution convenience if needed
      if (dep.title.includes('.')) {
          const base = dep.title.split('.')[0];
          if (!blobs[base]) blobs[base] = url;
      }
  });

  let finalContent = rootNode.content;

  // Wrap raw JS/CSS if root is not HTML
  const lowerTitle = rootNode.title.toLowerCase();
  if (lowerTitle.endsWith('.js') || lowerTitle.endsWith('.ts')) {
      finalContent = `<script type="module">\n${finalContent}\n</script>`;
  } else if (lowerTitle.endsWith('.css')) {
      finalContent = `<style>\n${finalContent}\n</style>`;
  }

  // 4. Inject Dependencies via Blob URLs
  // This preserves attributes like 'defer', 'async', 'type="module"'!
  
  // Replace <link href="style.css"> -> <link href="blob:...">
  finalContent = finalContent.replace(/<link([^>]+)href=["']([^"']+)["']([^>]*)>/gi, (match, p1, href, p3) => {
    // Check exact match or path match
    const filename = href.split('/').pop();
    if (filename && blobs[filename]) {
        return `<link${p1}href="${blobs[filename]}"${p3}>`;
    }
    return match;
  });

  // Replace <script src="script.js"> -> <script src="blob:...">
  finalContent = finalContent.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, p1, src, p3) => {
    const filename = src.split('/').pop();
    if (filename && blobs[filename]) {
        return `<script${p1}src="${blobs[filename]}"${p3}></script>`;
    }
    return match;
  });

  // 5. Inject Console Interceptor
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
                if (arg instanceof Error) return arg.toString();
                if (typeof arg === 'object') {
                    try { return JSON.stringify(arg); } catch(e) { return '[Object]'; }
                }
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
      })();
    </script>
    ${forceReload ? `<!-- Force Reload: ${Date.now()} -->` : ''}
  `;

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
};
