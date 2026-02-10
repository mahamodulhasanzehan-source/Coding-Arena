
import { GoogleGenAI, FunctionDeclaration, Type, Tool } from "@google/genai";
import { NodeData, GraphState, Action, Connection } from './types';
import { getRelatedNodes } from './utils/graphUtils';

// Helper to avoid TS errors with process.env if @types/node is missing
declare const process: any;

// --- 1. THE BRAIN: System Instructions ---
const SYSTEM_INSTRUCTIONS = `You are an expert full-stack coding assistant in NodeCode Studio.

CRITICAL RULES:
1. **NEVER DELETE FILES** unless the user explicitly asks to "delete" or "remove" a specific file. 
   - Prefer updating existing files over deleting and recreating them.
   - If a file exists, use 'updateFile' to modify it.
2. **WRITE COMPLETE CODE**:
   - Do not use placeholders like "// ... rest of code".
   - Write fully functional, interactive, and polished code.
   - Ensure HTML/CSS/JS are properly linked and functional.
3. **FILE OPERATIONS**:
   - To EDIT content, use 'updateFile'. Supports paths (e.g., 'folder/file.ext').
   - To MOVE/REWIRE, use 'moveFile(filename, folderName)'.
   - To WIRE dependencies, use 'connectFiles(sourceName, targetName)'.
   - To RENAME, use 'renameFile(oldName, newName)'.

FOLDER STRUCTURE:
   - Files connected to a "Folder Node" are conceptually inside it.
   - Paths are resolved visually.
`;

// --- 2. THE HANDS: Tool Definitions ---
const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Create or Update a file. Supports paths (e.g., "components/Button.tsx").',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The name or path of the file.' },
            code: { type: Type.STRING, description: 'The NEW full content of the file.' }
        },
        required: ['filename', 'code']
    }
};

const deleteFileFunction: FunctionDeclaration = {
    name: 'deleteFile',
    description: 'Delete a file (node) from the project. ONLY use if explicitly requested by user.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The name of the file to delete.' }
        },
        required: ['filename']
    }
};

const moveFileFunction: FunctionDeclaration = {
    name: 'moveFile',
    description: 'Rewire an EXISTING file into a folder or root. Disconnects old parents and connects to new.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the file node.' },
            targetFolderName: { type: Type.STRING, description: 'The destination folder name. Empty for root.' }
        },
        required: ['filename']
    }
};

const connectFilesFunction: FunctionDeclaration = {
    name: 'connectFiles',
    description: 'Create a connection/wire between two nodes (e.g. for imports).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            sourceName: { type: Type.STRING, description: 'Name of the source node (e.g. style.css).' },
            targetName: { type: Type.STRING, description: 'Name of the target node (e.g. index.html or components).' }
        },
        required: ['sourceName', 'targetName']
    }
};

const renameFileFunction: FunctionDeclaration = {
    name: 'renameFile',
    description: 'Rename a file node.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            oldName: { type: Type.STRING, description: 'The current name of the file.' },
            newName: { type: Type.STRING, description: 'The new name for the file.' }
        },
        required: ['oldName', 'newName']
    }
};

const TOOLS: Tool[] = [{ functionDeclarations: [updateCodeFunction, deleteFileFunction, moveFileFunction, connectFilesFunction, renameFileFunction] }];

// --- 3. HELPERS ---

const cleanAiOutput = (text: string): string => {
    return text.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

const getNodePath = (node: NodeData, nodes: NodeData[], connections: Connection[]) => {
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

const findNodeByPathOrTitle = (pathOrTitle: string, nodes: NodeData[], connections: Connection[]) => {
    return nodes.find(n => {
        if (n.title === pathOrTitle) return true;
        const path = getNodePath(n, nodes, connections);
        return path === pathOrTitle;
    });
};

async function performGeminiCall<T>(operation: (ai: GoogleGenAI) => Promise<T>): Promise<T> {
    const keys = [process.env.API_KEY, process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5].filter((k): k is string => !!k && k.length > 0);
    if (keys.length === 0) throw new Error("No Gemini API Keys configured.");

    let lastError: any;
    for (const apiKey of keys) {
        try {
            const ai = new GoogleGenAI({ apiKey });
            return await withTimeout(operation(ai), 60000, "AI Operation Timed Out (60s limit).");
        } catch (error: any) {
            lastError = error;
            if (error.status === 429 || error.message?.includes('429') || error.status === 503) {
                console.warn(`API Key ${apiKey.slice(0,5)}... rate limited. Switching...`);
                continue; 
            }
            throw error;
        }
    }
    throw lastError; 
}

// --- 4. EXECUTION LOGIC ---

interface AiContext {
    state: GraphState;
    dispatch: React.Dispatch<Action>;
    checkPermission: (id: string) => boolean;
    onHighlight: (id: string) => void;
}

const processToolCalls = (
    functionCalls: any[], 
    { state, dispatch, checkPermission, onHighlight }: AiContext,
    startNodeId: string
): string => {
    let toolOutput = '';
    let tempNodes = [...state.nodes]; // Local simulation for batch updates

    for (const call of functionCalls) {
        if (call.name === 'updateFile') {
            const args = call.args as any;
            const fullPath = args.filename;
            
            const parts = fullPath.split('/');
            const fileName = parts.pop(); 
            const folderName = parts.length > 0 ? parts.join('/') : null;

            let target = findNodeByPathOrTitle(fullPath, tempNodes, state.connections);
            if (!target) target = tempNodes.find(n => n.title === fileName && n.type === 'CODE');
            
            if (target) {
                if (checkPermission(target.id)) { 
                    dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } }); 
                    toolOutput += `\n[Updated ${target.title}]`; 
                    onHighlight(target.id); 
                } else { 
                    toolOutput += `\n[Error: ${fileName} is locked]`;
                    continue;
                }
            } else {
                // Create New File
                const newNodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                const anchorNode = tempNodes.find(n => n.id === startNodeId);
                const pos = anchorNode ? { x: anchorNode.position.x + 50, y: anchorNode.position.y + 50 } : { x: 100, y: 100 };
                
                const newNode: NodeData = { 
                    id: newNodeId, 
                    type: 'CODE', 
                    title: fileName, 
                    content: args.code, 
                    position: pos, 
                    size: { width: 450, height: 300 }, 
                    autoHeight: false 
                };
                
                dispatch({ type: 'ADD_NODE', payload: newNode });
                tempNodes.push(newNode); 
                target = newNode;
                toolOutput += `\n[Created ${fileName}]`;
                
                // Default: Wire to context if no folder specified
                if (!folderName) {
                    const contextNode = tempNodes.find(n => n.id === startNodeId);
                    if (contextNode && contextNode.type === 'CODE') {
                        dispatch({ type: 'CONNECT', payload: { id: `conn-auto-${Date.now()}`, sourceNodeId: newNodeId, sourcePortId: `${newNodeId}-out-dom`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                    }
                }
            }

            // Ensure Correct Folder Wiring
            if (folderName && target) {
                let folderNode = tempNodes.find(n => n.type === 'FOLDER' && n.title === folderName);
                
                if (!folderNode) {
                    const folderId = `folder-${Date.now()}`;
                    const anchor = tempNodes.find(n => n.id === startNodeId);
                    const folderPos = anchor ? { x: anchor.position.x - 250, y: anchor.position.y } : { x: 100, y: 100 };
                    
                    const newFolder: NodeData = { 
                        id: folderId, type: 'FOLDER', title: folderName, content: '', position: folderPos, size: { width: 250, height: 300 } 
                    };
                    
                    dispatch({ type: 'ADD_NODE', payload: newFolder });
                    tempNodes.push(newFolder);
                    folderNode = newFolder;
                    toolOutput += `\n[Created Folder '${folderName}']`;
                }

                // REWIRING LOGIC: Disconnect from everything EXCEPT Outputs (Preview/Terminal)
                const outgoingConns = state.connections.filter(c => c.sourceNodeId === target!.id);
                const connectionsToRemove = outgoingConns.filter(c => {
                     const t = tempNodes.find(n => n.id === c.targetNodeId);
                     if (!t) return true;
                     // Keep Preview and Terminal connections
                     if (t.type === 'PREVIEW' || t.type === 'TERMINAL') return false;
                     // Remove everything else (Code, Folders, etc)
                     return true;
                });
                connectionsToRemove.forEach(c => dispatch({ type: 'DISCONNECT', payload: c.id }));

                dispatch({ type: 'CONNECT', payload: { id: `conn-folder-${Date.now()}`, sourceNodeId: target.id, sourcePortId: `${target.id}-out-dom`, targetNodeId: folderNode.id, targetPortId: `${folderNode.id}-in-files` }});
                toolOutput += `\n[Moved ${fileName} to ${folderName}]`;
            }

        } else if (call.name === 'moveFile') {
            const args = call.args as any;
            const { filename, targetFolderName } = args;
            // Robust finding: support path or title
            let targetNode = findNodeByPathOrTitle(filename, tempNodes, state.connections);
            if (!targetNode) targetNode = tempNodes.find(n => n.title === filename);

            if (targetNode && (targetNode.type === 'CODE' || targetNode.type === 'IMAGE' || targetNode.type === 'TEXT') && checkPermission(targetNode.id)) {
                // 1. AGGRESSIVE DISCONNECT
                // Disconnect from everything EXCEPT Outputs (Preview/Terminal)
                const outgoingConns = state.connections.filter(c => c.sourceNodeId === targetNode!.id);
                const connectionsToRemove = outgoingConns.filter(c => {
                     const t = tempNodes.find(n => n.id === c.targetNodeId);
                     if (!t) return true;
                     // Keep Preview and Terminal connections to preserve runtime visualization
                     if (t.type === 'PREVIEW' || t.type === 'TERMINAL') return false;
                     // Remove connections to Main HTML (Imports) or other Folders
                     return true;
                });
                
                connectionsToRemove.forEach(c => dispatch({ type: 'DISCONNECT', payload: c.id }));

                if (targetFolderName) {
                    let folderNode = tempNodes.find(n => n.type === 'FOLDER' && n.title === targetFolderName);
                    
                    if (!folderNode) {
                        const folderId = `folder-${Date.now()}`;
                        const newFolder: NodeData = { id: folderId, type: 'FOLDER', title: targetFolderName, content: '', position: { x: targetNode.position.x - 200, y: targetNode.position.y }, size: { width: 250, height: 300 } };
                        dispatch({ type: 'ADD_NODE', payload: newFolder });
                        tempNodes.push(newFolder);
                        folderNode = newFolder;
                        toolOutput += `\n[Created Folder ${targetFolderName}]`;
                    }
                    
                    dispatch({ type: 'CONNECT', payload: { id: `conn-${Date.now()}-${Math.random()}`, sourceNodeId: targetNode.id, sourcePortId: `${targetNode.id}-out-dom`, targetNodeId: folderNode.id, targetPortId: `${folderNode.id}-in-files` } });
                    toolOutput += `\n[Moved ${filename} to ${targetFolderName}]`;
                } else {
                    toolOutput += `\n[Moved ${filename} to Root]`;
                }
            } else {
                toolOutput += `\n[Error: Could not find ${filename}]`;
            }

        } else if (call.name === 'connectFiles') {
            const args = call.args as any;
            const { sourceName, targetName } = args;
            
            const source = tempNodes.find(n => n.title === sourceName);
            const target = tempNodes.find(n => n.title === targetName);
            
            if (source && target) {
                if (target.type === 'FOLDER') {
                     // Aggressive disconnect for folders (Move behavior)
                     const outgoingConns = state.connections.filter(c => c.sourceNodeId === source.id);
                     const connectionsToRemove = outgoingConns.filter(c => {
                         const t = tempNodes.find(n => n.id === c.targetNodeId);
                         if (!t) return true;
                         if (t.type === 'PREVIEW' || t.type === 'TERMINAL') return false;
                         return true;
                     });
                     connectionsToRemove.forEach(c => dispatch({ type: 'DISCONNECT', payload: c.id }));

                     dispatch({ type: 'CONNECT', payload: { id: `conn-man-${Date.now()}`, sourceNodeId: source.id, sourcePortId: `${source.id}-out-dom`, targetNodeId: target.id, targetPortId: `${target.id}-in-files` } });
                     toolOutput += `\n[Connected ${sourceName} -> ${targetName}]`;
                } else if (target.type === 'CODE') {
                     dispatch({ type: 'CONNECT', payload: { id: `conn-man-${Date.now()}`, sourceNodeId: source.id, sourcePortId: `${source.id}-out-dom`, targetNodeId: target.id, targetPortId: `${target.id}-in-file` } });
                     toolOutput += `\n[Connected ${sourceName} -> ${targetName}]`;
                }
            } else {
                toolOutput += `\n[Error: Could not find nodes for connection ${sourceName}->${targetName}]`;
            }

        } else if (call.name === 'renameFile') {
            const args = call.args as any;
            const { oldName, newName } = args;
            const targetIndex = tempNodes.findIndex(n => n.title === oldName && n.type === 'CODE');
            
            if (targetIndex !== -1 && checkPermission(tempNodes[targetIndex].id)) {
                const target = tempNodes[targetIndex];
                dispatch({ type: 'UPDATE_NODE_TITLE', payload: { id: target.id, title: newName } });
                tempNodes[targetIndex] = { ...target, title: newName };
                toolOutput += `\n[Renamed ${oldName} to ${newName}]`;
            } else {
                toolOutput += `\n[Error: Could not rename ${oldName}]`;
            }

        } else if (call.name === 'deleteFile') {
            const args = call.args as any;
            const targetIndex = tempNodes.findIndex(n => n.title === args.filename && n.type === 'CODE');
            if (targetIndex !== -1) {
                const target = tempNodes[targetIndex];
                if (checkPermission(target.id)) {
                    dispatch({ type: 'DELETE_NODE', payload: target.id });
                    tempNodes.splice(targetIndex, 1);
                    toolOutput += `\n[Deleted ${args.filename}]`;
                }
            }
        }
    }
    return toolOutput;
};

export const handleAiMessage = async (nodeId: string, text: string, context: AiContext) => {
    const { state, dispatch } = context;
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    // AUTHORITY EXPANSION
    // We only traverse nodes that are actually connected. Unconnected nodes are ignored.
    const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
    const allContextNodeIds = Array.from(new Set([
        ...relatedNodes.map(n => n.id), 
        ...(node.contextNodeIds || []),
        nodeId
    ]));
    
    const contextFiles = allContextNodeIds
        .map(id => state.nodes.find(n => n.id === id))
        .filter((n): n is NodeData => !!n && n.type === 'CODE');

    const nodesToLock = new Set<string>(allContextNodeIds);
    contextFiles.forEach(file => {
        const folderConn = state.connections.find(c => c.sourceNodeId === file.id && state.nodes.find(n => n.id === c.targetNodeId)?.type === 'FOLDER');
        if (folderConn) nodesToLock.add(folderConn.targetNodeId);
    });

    dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
    nodesToLock.forEach(id => dispatch({ type: 'SET_NODE_LOADING', payload: { id, isLoading: true } }));

    // CRITICAL: Filter state.nodes to ONLY those in allContextNodeIds to prevent contamination
    const nodesInContext = state.nodes.filter(n => allContextNodeIds.includes(n.id));

    const structureContext = nodesInContext
      .filter(n => n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT' || n.type === 'FOLDER')
      .map(n => {
          if (n.type === 'FOLDER') return `[FOLDER] ${n.title}`;
          const path = getNodePath(n, state.nodes, state.connections);
          return `- ${path} (${n.type})`;
      })
      .join('\n');

    const fileContext = contextFiles.map(n => {
        const path = getNodePath(n, state.nodes, state.connections);
        return `File Path: ${path}\nContent:\n${n.content}`;
    }).join('\n\n');
    
    const dynamicSystemInstruction = `${SYSTEM_INSTRUCTIONS}

    CONNECTED CONTEXT FILES (You have authority over these):
    ${structureContext}

    Use this list to identify files. If a file is shown as 'components/Button.tsx', refer to it by that path.
    `;

    try {
        dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });
        
        await performGeminiCall(async (ai) => {
            const result = await ai.models.generateContentStream({ 
                model: 'gemini-3-flash-preview', 
                contents: [{ role: 'user', parts: [{ text: `Query: ${text}\n\nSelected File Content Context:\n${fileContext}` }] }], 
                config: { 
                    systemInstruction: dynamicSystemInstruction, 
                    tools: TOOLS 
                } 
            });
            
            let fullText = '';
            const functionCalls: any[] = [];
            
            for await (const chunk of result) {
                if (chunk.text) { 
                    fullText += chunk.text; 
                    dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } }); 
                }
                if (chunk.functionCalls) functionCalls.push(...chunk.functionCalls);
            }
            
            if (functionCalls.length > 0) {
                const toolOutput = processToolCalls(functionCalls, context, nodeId);
                if (toolOutput) dispatch({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText + toolOutput } });
            }
        });
    } catch (error: any) { 
        dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${error.message}` } } }); 
    } finally { 
        nodesToLock.forEach(id => dispatch({ type: 'SET_NODE_LOADING', payload: { id, isLoading: false } })); 
    }
};

export const handleAiGeneration = async (
    nodeId: string, 
    action: 'optimize' | 'prompt', 
    promptText: string | undefined, 
    context: AiContext
) => {
    const { state, dispatch, checkPermission, onHighlight } = context;
    const startNode = state.nodes.find(n => n.id === nodeId);
    if (!startNode || startNode.type !== 'CODE' || !checkPermission(nodeId)) return;
    
    // Strict Context Isolation: Only Traverse Connected Nodes
    const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
    const relatedIds = new Set(relatedNodes.map(n => n.id));
    relatedIds.add(nodeId); // Ensure start node is included

    // Filter the global node list to ONLY relevant nodes
    const nodesInContext = state.nodes.filter(n => relatedIds.has(n.id));
    
    const targetNodes = nodesInContext.filter(n => n.type === 'CODE' || n.type === 'FOLDER');
    
    targetNodes.forEach(n => dispatch({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: true } }));
    
    try {
        const structureContext = nodesInContext
          .filter(n => n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT' || n.type === 'FOLDER')
          .map(n => {
              const path = getNodePath(n, state.nodes, state.connections);
              return `- ${path} (${n.type})`;
          })
          .join('\n');

        // IMPORTANT: Inject Content of Connected Files
        const fileContext = nodesInContext
            .filter(n => n.type === 'CODE')
            .map(n => {
                const path = getNodePath(n, state.nodes, state.connections);
                return `File Path: ${path}\nContent:\n${n.content}`;
            })
            .join('\n\n');

        const dynamicSystemInstruction = `${SYSTEM_INSTRUCTIONS}

        CURRENT PROJECT FILES (Structural Context - Connected Nodes Only):
        ${structureContext}
        `;

        const userPrompt = action === 'optimize' 
            ? `Optimize the file ${startNode.title}.` 
            : `Request: ${promptText}\n\nIMPORTANT: Write complete, functional code for this request. Do not use placeholders. Modify connected files if needed.\n\nCONTEXTUAL FILE CONTENTS:\n${fileContext}`;

        await performGeminiCall(async (ai) => {
             const result = await ai.models.generateContent({ 
                 model: 'gemini-3-flash-preview', 
                 contents: userPrompt, 
                 config: { 
                     systemInstruction: dynamicSystemInstruction, 
                     tools: TOOLS
                 } 
             });
             
             const functionCalls = result.functionCalls;
             
             if (functionCalls && functionCalls.length > 0) {
                 processToolCalls(functionCalls, context, nodeId);
             } else if (result.text) {
                 dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: cleanAiOutput(result.text) } });
                 onHighlight(nodeId);
             }
        });
    } catch (e: any) { 
        alert(`AI Error: ${e.message}`); 
    } finally { 
        targetNodes.forEach(n => dispatch({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: false } })); 
    }
};
        