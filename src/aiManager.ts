
import { GoogleGenAI, FunctionDeclaration, Type } from "@google/genai";
import { NodeData, GraphState, Action, Connection } from './types';
import { getRelatedNodes } from './utils/graphUtils';

// Helper to avoid TS errors with process.env if @types/node is missing
declare const process: any;

// --- 1. THE BRAIN: System Instructions ---
const SYSTEM_INSTRUCTIONS = `You are a coding assistant in NodeCode Studio.

RULES:
1. To EDIT content, use 'updateFile'. 
   - You can specify a path like 'folder/file.ext'.
   - If the file doesn't exist, it will be created.
   - If a folder path is provided, the file will be automatically moved/wired into that folder.
2. To MOVE a file, use 'moveFile(filename, folderName)'. 
   - This operates on EXISTING files.
   - It changes the visual connections in the graph.
   - To move to root, leave targetFolderName empty.
3. To RENAME a file, use 'renameFile(oldName, newName)'.
   - Renaming only changes the Title (e.g. 'script.js' -> 'main.js').
   - Do NOT use this to move files (e.g. do NOT rename to 'folder/script.js').
4. FOLDER STRUCTURE:
   - This environment uses "Folder Nodes". Files connected to a folder are "inside" it.
   - The context list below shows paths like 'components/Button.tsx'.
   - DEFAULT BEHAVIOR: Place all new components, styles, and utils into appropriate folders (e.g. 'components', 'styles', 'lib').
   - Keep the main entry point (usually index.html) at the root.
5. SCOPE:
   - You have authority over ALL files listed in the "Connected Context".
   - You can edit any file in the chain, not just the one currently selected.
`;

// --- 2. THE HANDS: Tool Definitions ---
const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Create or Update a file. Supports paths (e.g., "components/Button.tsx"). If folder doesn\'t exist, it creates it.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The name or path of the file (e.g. "script.js" or "lib/utils.js").' },
            code: { type: Type.STRING, description: 'The NEW full content of the file.' }
        },
        required: ['filename', 'code']
    }
};

const deleteFileFunction: FunctionDeclaration = {
    name: 'deleteFile',
    description: 'Delete a file (node) from the project.',
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
    description: 'Move an EXISTING file into a folder or to root. This REWIRES the connections.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'The exact name of the existing file node to move.' },
            targetFolderName: { type: Type.STRING, description: 'The exact name of the destination folder node. Leave empty/null to move to root.' }
        },
        required: ['filename']
    }
};

const renameFileFunction: FunctionDeclaration = {
    name: 'renameFile',
    description: 'Rename a file node. DO NOT use paths here.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            oldName: { type: Type.STRING, description: 'The current name of the file.' },
            newName: { type: Type.STRING, description: 'The new name for the file (no paths).' }
        },
        required: ['oldName', 'newName']
    }
};

const TOOLS = [{ functionDeclarations: [updateCodeFunction, deleteFileFunction, moveFileFunction, renameFileFunction] }];

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

// Helper to determine the "virtual path" of a node based on connections
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

// Helper to find a node by its Title OR its Path
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
                console.warn(`API Key ${apiKey.slice(0,5)}... rate limited or unavailable. Switching...`);
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

// Common logic to process tool calls
const processToolCalls = (
    functionCalls: any[], 
    { state, dispatch, checkPermission, onHighlight }: AiContext,
    startNodeId: string
): string => {
    let toolOutput = '';
    // Local simulation of node state for batch operations
    let tempNodes = [...state.nodes];

    for (const call of functionCalls) {
        if (call.name === 'updateFile') {
            const args = call.args as any;
            const fullPath = args.filename;
            
            // Handle Path Parsing (e.g., "components/Button.tsx")
            const parts = fullPath.split('/');
            const fileName = parts.pop(); 
            const folderName = parts.length > 0 ? parts.join('/') : null;

            // Try to find existing node by full path (or just title if unique)
            let target = findNodeByPathOrTitle(fullPath, tempNodes, state.connections);
            // Fallback: search by filename only if exact path not found
            if (!target) target = tempNodes.find(n => n.title === fileName && n.type === 'CODE');
            
            if (target) {
                if (checkPermission(target.id)) { 
                    dispatch({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } }); 
                    toolOutput += `\n[Updated ${target.title}]`; 
                    onHighlight(target.id); 
                    
                    // If path implies a folder, ensure it's wired correctly
                    if (folderName) {
                         // Check if already connected to this folder
                         const currentPath = getNodePath(target, tempNodes, state.connections);
                         if (!currentPath.startsWith(folderName + '/')) {
                             // Needs moving/wiring
                             // Logic continues below to "ensure folder connection"
                         } else {
                             // Already in correct folder
                             continue; 
                         }
                    } else {
                        continue;
                    }
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
                
                // Wire to Context if not putting in a folder (default behavior)
                if (!folderName) {
                    const contextNode = tempNodes.find(n => n.id === startNodeId);
                    if (contextNode && contextNode.type === 'CODE') {
                        dispatch({ type: 'CONNECT', payload: { id: `conn-auto-${Date.now()}`, sourceNodeId: newNodeId, sourcePortId: `${newNodeId}-out-dom`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                    }
                }
            }

            // --- Handle Folder Wiring (for both new and existing) ---
            if (folderName && target) {
                // Find or Create Folder Node
                let folderNode = tempNodes.find(n => n.type === 'FOLDER' && n.title === folderName);
                
                if (!folderNode) {
                    const folderId = `folder-${Date.now()}`;
                    const anchor = tempNodes.find(n => n.id === startNodeId);
                    const folderPos = anchor ? { x: anchor.position.x - 250, y: anchor.position.y } : { x: 100, y: 100 };
                    
                    const newFolder: NodeData = { 
                        id: folderId, 
                        type: 'FOLDER', 
                        title: folderName, 
                        content: '', 
                        position: folderPos, 
                        size: { width: 250, height: 300 } 
                    };
                    
                    dispatch({ type: 'ADD_NODE', payload: newFolder });
                    tempNodes.push(newFolder);
                    folderNode = newFolder;
                    toolOutput += `\n[Created Folder '${folderName}']`;
                }

                // Disconnect from other folders first (enforce single parent for now)
                const existingFolderConns = state.connections.filter(c => 
                    c.sourceNodeId === target!.id && 
                    tempNodes.find(n => n.id === c.targetNodeId)?.type === 'FOLDER'
                );
                existingFolderConns.forEach(c => dispatch({ type: 'DISCONNECT', payload: c.id }));

                // Connect File -> Folder
                dispatch({ type: 'CONNECT', payload: { 
                    id: `conn-folder-${Date.now()}`, 
                    sourceNodeId: target.id, 
                    sourcePortId: `${target.id}-out-dom`, 
                    targetNodeId: folderNode.id, 
                    targetPortId: `${folderNode.id}-in-files` 
                }});
                toolOutput += `\n[Wired ${fileName} to ${folderName}]`;
                
                // Optional: Connect Folder -> Main Context (if main context needs access)
                // This ensures the graph remains connected if we moved a dependency
                const contextNode = tempNodes.find(n => n.id === startNodeId);
                if (contextNode && contextNode.type === 'CODE' && contextNode.id !== target.id) {
                     // Check if folder is already connected to context
                     const isConnected = state.connections.some(c => c.sourceNodeId === folderNode!.id && c.targetNodeId === contextNode.id);
                     if (!isConnected) {
                         dispatch({ type: 'CONNECT', payload: { id: `conn-ctx-${Date.now()}`, sourceNodeId: folderNode.id, sourcePortId: `${folderNode.id}-out-folder`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                     }
                }
            }

        } else if (call.name === 'moveFile') {
            const args = call.args as any;
            const { filename, targetFolderName } = args;
            const targetNode = tempNodes.find(n => n.title === filename && (n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT'));
            
            if (targetNode && checkPermission(targetNode.id)) {
                // Disconnect current outputs
                const existingOutputs = state.connections.filter(c => c.sourceNodeId === targetNode.id && c.sourcePortId.includes('out-dom'));
                existingOutputs.forEach(c => dispatch({ type: 'DISCONNECT', payload: c.id }));

                if (targetFolderName) {
                    // Move to Folder
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
                    // Move to Root (Connect to Context Node directly)
                    const contextNode = tempNodes.find(n => n.id === startNodeId);
                    if (contextNode && contextNode.type === 'CODE') {
                        dispatch({ type: 'CONNECT', payload: { id: `conn-root-${Date.now()}-${Math.random()}`, sourceNodeId: targetNode.id, sourcePortId: `${targetNode.id}-out-dom`, targetNodeId: contextNode.id, targetPortId: `${contextNode.id}-in-file` } });
                        toolOutput += `\n[Moved ${filename} to Root]`;
                    }
                }
            } else {
                toolOutput += `\n[Error: Could not find ${filename} to move]`;
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

// Main Chat Handler
export const handleAiMessage = async (
    nodeId: string, 
    text: string, 
    context: AiContext
) => {
    const { state, dispatch } = context;
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    // AUTHORITY EXPANSION: Get entire connected subgraph
    const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
    // Merge with any manual selections
    const allContextNodeIds = Array.from(new Set([
        ...relatedNodes.map(n => n.id), 
        ...(node.contextNodeIds || []),
        nodeId
    ]));
    
    const contextFiles = allContextNodeIds
        .map(id => state.nodes.find(n => n.id === id))
        .filter((n): n is NodeData => !!n && n.type === 'CODE');

    // Lock all involved nodes
    const nodesToLock = new Set<string>(allContextNodeIds);
    
    // Find connected folders to lock as well
    contextFiles.forEach(file => {
        const folderConn = state.connections.find(c => c.sourceNodeId === file.id && state.nodes.find(n => n.id === c.targetNodeId)?.type === 'FOLDER');
        if (folderConn) nodesToLock.add(folderConn.targetNodeId);
    });

    dispatch({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });
    nodesToLock.forEach(id => dispatch({ type: 'SET_NODE_LOADING', payload: { id, isLoading: true } }));

    // Prepare Context String with PATHS
    const structureContext = state.nodes
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

// "Optimize" or "Prompt" Handler
export const handleAiGeneration = async (
    nodeId: string, 
    action: 'optimize' | 'prompt', 
    promptText: string | undefined, 
    context: AiContext
) => {
    const { state, dispatch, checkPermission, onHighlight } = context;
    const startNode = state.nodes.find(n => n.id === nodeId);
    if (!startNode || startNode.type !== 'CODE' || !checkPermission(nodeId)) return;
    
    // AUTHORITY EXPANSION
    const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
    // Also include folders connected to these nodes
    const targetNodes = relatedNodes.filter(n => n.type === 'CODE' || n.type === 'FOLDER');
    
    targetNodes.forEach(n => dispatch({ type: 'SET_NODE_LOADING', payload: { id: n.id, isLoading: true } }));
    
    try {
        const structureContext = state.nodes
          .filter(n => n.type === 'CODE' || n.type === 'IMAGE' || n.type === 'TEXT' || n.type === 'FOLDER')
          .map(n => {
              const path = getNodePath(n, state.nodes, state.connections);
              return `- ${path} (${n.type})`;
          })
          .join('\n');

        const dynamicSystemInstruction = `${SYSTEM_INSTRUCTIONS}

        CURRENT PROJECT FILES (Structural Context):
        ${structureContext}
        `;

        const userPrompt = action === 'optimize' ? `Optimize the file ${startNode.title}.` : `Request: ${promptText}\n\n(Focus on ${startNode.title}...)`;

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
