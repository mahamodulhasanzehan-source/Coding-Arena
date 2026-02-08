
import { Connection, NodeData, NodeType, Port } from '../types';
import { getPortsForNode } from '../constants';
// @ts-ignore: Externalized in vite.config.ts, types not needed for build
import * as Babel from '@babel/standalone';

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

// Helper: Determine the virtual path of a node (e.g. "components/Header.js")
const getNodePath = (node: NodeData, nodes: NodeData[], connections: Connection[]): string => {
    const folderConn = connections.find(c => 
        c.sourceNodeId === node.id && 
        nodes.find(n => n.id === c.targetNodeId)?.type === 'FOLDER'
    );
    if (folderConn) {
        const folder = nodes.find(n => n.id === folderConn.targetNodeId);
        if (folder) return `${folder.title}/${node.title}`;
    }
    return node.title;
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
            // If connected to a folder, get contents of that folder
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

// Helper: Sanitize filename to valid identifier
const toIdentifier = (filename: string) => {
    const base = filename.replace(/\.[^/.]+$/, "");
    return base.replace(/[^a-zA-Z0-9_$]/g, "_");
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
        <head>
            <style>body { background-color: #0f0f11; color: #71717a; font-family: sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }</style>
        </head>
        <body>
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

  // 2. Prepare Maps
  const pathToBlobUrl: Record<string, string> = {};
  let cssContent = '';
  
  const allNodes = [rootNode, ...uniqueDeps];
  
  // 3. Process CSS first
  allNodes.forEach(node => {
      if (node.title.toLowerCase().endsWith('.css')) {
          cssContent += `\n/* ${node.title} */\n${node.content}\n`;
      }
  });

  // 4. Process JS/JSX/TS - create Blobs for modules
  allNodes.forEach(node => {
      const lower = node.title.toLowerCase();
      if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.tsx')) {
          try {
              let content = node.content;

              // AUTO-IMPORT INJECTION: Detect connections and inject import statements if missing
              const imports = getAllConnectedSources(node.id, 'file', nodes, connections);
              imports.forEach(imp => {
                  if (imp.type === 'CODE' || imp.type === 'NPM') {
                      const identifier = toIdentifier(imp.title);
                      // Look for usage of identifier, but ignore if already imported
                      const hasImport = new RegExp(`import\\s+.*?['"](.*/)?${imp.title}['"]`).test(content);
                      const hasIdentifierImport = new RegExp(`import\\s+.*?\\b${identifier}\\b`).test(content);

                      if (!hasImport && !hasIdentifierImport) {
                          // Inject default import.
                          content = `import ${identifier} from './${imp.title}';\n` + content;
                      }
                  }
              });

              // Transpile using Babel
              let transformFn = (Babel as any).transform;
              if (!transformFn && (Babel as any).default && (Babel as any).default.transform) {
                  transformFn = (Babel as any).default.transform;
              }

              let transformedCode = content;
              if (transformFn) {
                 // @ts-ignore
                 const res = transformFn(content, {
                     presets: ['react', 'env'],
                     filename: node.title
                 });
                 transformedCode = res.code;
              }

              const blob = new Blob([transformedCode], { type: 'application/javascript' });
              const blobUrl = URL.createObjectURL(blob);
              
              const fullPath = getNodePath(node, nodes, connections);
              const fileName = node.title;
              const fileNameNoExt = fileName.replace(/\.[^/.]+$/, "");
              
              // Register multiple paths for the same file to handle various import styles
              const paths = [
                  fileName,
                  `./${fileName}`,
                  `/${fileName}`,
                  fileNameNoExt,
                  `./${fileNameNoExt}`,
                  `/${fileNameNoExt}`,
                  fullPath,
                  `./${fullPath}`,
                  `/${fullPath}`
              ];

              paths.forEach(p => {
                  if (p) pathToBlobUrl[p] = blobUrl;
              });
              
          } catch (e: any) {
              console.error(`Failed to transpile ${node.title}:`, e);
              // Register an error script to throw immediately in the preview
              const errBlob = new Blob([`console.error("Transpilation Error in ${node.title}: ${e.message.replace(/"/g, '\\"')}");`], { type: 'application/javascript' });
              pathToBlobUrl[node.title] = URL.createObjectURL(errBlob);
          }
      }
  });

  // 5. Build Import Map
  const importMap = {
    imports: {
      "react": "https://esm.sh/react@18.2.0",
      "react-dom/client": "https://esm.sh/react-dom@18.2.0/client",
      "react-dom": "https://esm.sh/react-dom@18.2.0",
      ...pathToBlobUrl 
    }
  };

  // 6. Error Interceptor Script
  const interceptorScript = `
    <script>
      (function() {
        function send(type, args) {
            try {
                const message = args.map(arg => {
                    if (arg === undefined) return 'undefined';
                    if (arg === null) return 'null';
                    if (arg instanceof Error) return arg.toString();
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
                console.warn('Failed to send log to parent', e);
            }
        }

        const oldLog = console.log;
        const oldError = console.error;
        const oldWarn = console.warn;
        const oldInfo = console.info;

        console.log = function(...args) { oldLog.apply(console, args); send('log', args); };
        console.error = function(...args) { oldError.apply(console, args); send('error', args); };
        console.warn = function(...args) { oldWarn.apply(console, args); send('warn', args); };
        console.info = function(...args) { oldInfo.apply(console, args); send('info', args); };
        
        window.addEventListener('error', function(event) {
           send('error', [event.message + ' (' + event.filename + ':' + event.lineno + ')']);
        });

        window.addEventListener('unhandledrejection', function(event) {
           send('error', ['Unhandled Promise Rejection: ' + event.reason]);
        });
      })();
    </script>
  `;

  // 7. Assemble HTML
  let htmlBody = '';
  const isHtmlRoot = rootNode.title.toLowerCase().endsWith('.html');

  if (isHtmlRoot) {
      htmlBody = rootNode.content;
      htmlBody = htmlBody.replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, ''); // Remove existing styles
      
      // Inject module imports
      htmlBody = htmlBody.replace(/<script\s+([^>]*?)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, p1, src, p3) => {
          const cleanSrc = src.replace(/^(\.\/|\/)/, '');
          const blobUrl = pathToBlobUrl[cleanSrc] || pathToBlobUrl[src] || pathToBlobUrl[`./${src}`];
          if (blobUrl) {
              return `<script type="module" src="${blobUrl}" ${p1} ${p3}></script>`;
          }
          return match;
      });
  } else {
      // JS Root
      htmlBody = '<div id="root"></div>';
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        ${interceptorScript}
        <style>
            ${cssContent}
        </style>
        <script type="importmap">
            ${JSON.stringify(importMap)}
        </script>
        <script type="module">
            import React from 'react';
            import ReactDOM from 'react-dom/client';
            window.React = React;
            window.ReactDOM = ReactDOM;
        </script>
      </head>
      <body>
        ${htmlBody}
        ${!isHtmlRoot ? `
        <script type="module">
            import Entry from '${pathToBlobUrl[rootNode.title] || rootNode.title}';
            const rootEl = document.getElementById('root');
            if (rootEl && Entry) {
                if (typeof Entry === 'function' || typeof Entry === 'object') {
                    try {
                        const root = window.ReactDOM.createRoot(rootEl);
                        root.render(window.React.createElement(Entry));
                    } catch(e) {
                        console.error("Auto-mount failed:", e);
                    }
                }
            }
        </script>` : ''}
      </body>
    </html>
  `;
};
