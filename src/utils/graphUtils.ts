
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

  const startY = node.isMinimized ? 14 : PORT_START_Y;
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

export const getRelatedNodes = (
  startNodeId: string,
  nodes: NodeData[],
  connections: Connection[],
  typeFilter?: NodeType
): NodeData[] => {
  const visited = new Set<string>();
  const queue = [startNodeId];
  const related: NodeData[] = [];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = nodes.find(n => n.id === currentId);
    if (node) {
       if (!typeFilter || node.type === typeFilter) {
           related.push(node);
       }
    }

    const neighbors = connections
      .filter(c => c.sourceNodeId === currentId || c.targetNodeId === currentId)
      .map(c => c.sourceNodeId === currentId ? c.targetNodeId : c.sourceNodeId);
    
    neighbors.forEach(nid => {
        if (!visited.has(nid)) queue.push(nid);
    });
  }
  
  return related;
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
    let allDeps: NodeData[] = [];

    for (const dep of directDeps) {
        if (dep.type === 'FOLDER') {
            const folderContents = getAllConnectedSources(dep.id, 'files', nodes, connections);
            allDeps = [...allDeps, ...folderContents];
            
            folderContents.forEach(child => {
                const nested = collectDependencies(child, nodes, connections, visited);
                allDeps = [...allDeps, ...nested];
            });
        } else {
            allDeps.push(dep);
            const nested = collectDependencies(dep, nodes, connections, visited);
            allDeps = [...allDeps, ...nested];
        }
    }

    return allDeps;
};

export const compilePreview = (
  previewNodeId: string,
  nodes: NodeData[],
  connections: Connection[],
  forceReload: boolean = false
): string => {
  const rootNode = getConnectedSource(previewNodeId, 'dom', nodes, connections);
  
  if (!rootNode) {
    return `
      <!DOCTYPE html>
      <html>
        <body style="background-color: #0f0f11; color: #71717a; font-family: sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0;">
          <div style="text-align: center;">
            <p>Connect a <strong>CODE Canvas</strong> (index.html or App.js) to the DOM port.</p>
          </div>
        </body>
      </html>
    `;
  }

  // 1. Collect all reachable dependencies
  const dependencyNodes = collectDependencies(rootNode, nodes, connections);
  const uniqueDeps = Array.from(new Set(dependencyNodes.map(n => n.id)))
      .map(id => nodes.find(n => n.id === id)!)
      .filter(n => n.id !== rootNode.id); 

  // 2. Separate Resources
  let cssContent = '';
  const jsFiles: Record<string, string> = {};
  
  const allNodes = [rootNode, ...uniqueDeps];
  
  allNodes.forEach(node => {
      const lower = node.title.toLowerCase();
      if (lower.endsWith('.css')) {
          cssContent += `\n/* ${node.title} */\n${node.content}\n`;
      } else if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.tsx')) {
          jsFiles[node.title] = node.content;
      }
  });

  // 3. Prepare HTML Body
  let htmlBody = '';
  const isHtmlRoot = rootNode.title.toLowerCase().endsWith('.html');

  if (isHtmlRoot) {
      htmlBody = rootNode.content;
      // Remove <link rel="stylesheet"> tags since we inject CSS manually
      htmlBody = htmlBody.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '');
      
      // Ensure local script tags use type="module" so they hit our Import Map
      // Replaces <script src="./App.js"> with <script type="module" src="./App.js">
      htmlBody = htmlBody.replace(/<script\s+([^>]*?)src=["'](\.\/)?([^"']+\.jsx?|[^"']+\.tsx?)["']([^>]*)>/gi, (match, p1, p2, filename, p3) => {
          if (jsFiles[filename]) {
              return `<script type="module" src="./${filename}" ${p1} ${p3}>`;
          }
          return match;
      });
  } else {
      // If root is JS, create a default React mount point
      htmlBody = '<div id="root"></div>';
  }

  // 4. Build the final HTML document with Babel and Import Maps
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        
        <!-- Utilities -->
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        
        <!-- Injected Styles -->
        <style>
            ${cssContent}
        </style>

        <!-- Console Interceptor -->
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
              } catch (e) {}
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
      </head>
      <body>
        ${htmlBody}

        <!-- Dynamic Module Loader -->
        <script>
          const jsFiles = ${JSON.stringify(jsFiles)};
          
          // Default Import Map for React
          const importMap = {
            imports: {
              "react": "https://esm.sh/react@18.2.0",
              "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
              "react-dom": "https://esm.sh/react-dom@18.2.0",
            }
          };

          try {
              // 1. Transpile all JS/JSX files using Babel
              for (const [filename, content] of Object.entries(jsFiles)) {
                  const output = Babel.transform(content, { 
                      presets: ['react', 'env'],
                      filename: filename 
                  }).code;
                  
                  // 2. Create Blob URLs for the transpiled code
                  const blob = new Blob([output], { type: 'application/javascript' });
                  const url = URL.createObjectURL(blob);
                  
                  // 3. Add to Import Map (supporting ./ relative imports)
                  importMap.imports['./' + filename] = url;
                  importMap.imports[filename] = url;
              }
              
              // 4. Inject Import Map
              const mapEl = document.createElement('script');
              mapEl.type = 'importmap';
              mapEl.textContent = JSON.stringify(importMap);
              document.head.appendChild(mapEl);
              
          } catch (e) {
              console.error("Transpilation/Build Error:", e);
          }
        </script>

        <!-- Entry Point Execution (if Root is JS) -->
        <script type="module">
            ${!isHtmlRoot ? `import './${rootNode.title}';` : ''}
        </script>
        
        ${forceReload ? `<!-- Force Reload: ${Date.now()} -->` : ''}
      </body>
    </html>
  `;
};
