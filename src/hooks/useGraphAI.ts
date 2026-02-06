import { GoogleGenAI } from "@google/genai";
import { GraphState, Action, NodeData } from '../types';
import { NODE_DEFAULTS } from '../constants';
import { getRelatedNodes } from '../utils/graphUtils';
import { createFileFunction, connectFilesFunction, updateCodeFunction, renameFileFunction, deleteFileFunction } from '../tools';

export const useGraphAI = (
    state: GraphState,
    dispatch: React.Dispatch<Action>,
    dispatchLocal: (action: Action) => void
) => {

    const handleHighlightNode = (id: string) => {
        // This is a bit of a hack to access the highlighter from the hook, 
        // ideally highlighting state should be in the reducer or context.
        // For now, we rely on the side effect in App.tsx watching state changes or we accept we can't highlight from here easily without extra wiring.
        // We'll dispatch a 'dummy' loading state toggle to trigger re-renders if needed, but visual highlighting is UI state.
        // We will skip explicit highlighting here and assume the UI reacts to content updates.
    };

    const handleSendMessage = async (nodeId: string, text: string) => {
        // 1. Identify all nodes to shimmer (Whole cluster)
        const relatedNodes = getRelatedNodes(nodeId, state.nodes, state.connections);
        const allNodeIds = new Set(relatedNodes.map(n => n.id));
        allNodeIds.add(nodeId);
        
        // Also include explicitly context-selected files
        const node = state.nodes.find(n => n.id === nodeId);
        node?.contextNodeIds?.forEach(id => allNodeIds.add(id));

        const idsToShimmer = Array.from(allNodeIds);

        // Turn ON Loading Shimmer for all
        idsToShimmer.forEach(id => {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id, isLoading: true } });
        });

        dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'user', text } } });

        const contextFiles = (node?.contextNodeIds || [])
            .map(id => state.nodes.find(n => n.id === id))
            .filter(n => n && n.type === 'CODE');

        const fileContext = contextFiles.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');

        // STRICT SYSTEM INSTRUCTION FOR VIBE CODING
        const systemInstruction = `You are an expert "Vibe Coding" Architect.
        Your goal is to build complex, modular web applications in a node-based environment.

        CRITICAL RULES:
        1. **MODULARITY**: You MUST split code into separate files (HTML, CSS, JS). NEVER dump everything into one file unless explicitly asked for a snippet.
        2. **FILE CREATION**: If the user wants a new feature (e.g. "make a game"), you MUST use \`createFile\` to make \`index.html\`, \`game.js\`, \`style.css\` separately.
        3. **CONNECTION**: After creating files, you MUST use \`connectFiles\` to wire them (e.g. connect \`style.css\` to \`index.html\`).
        4. **NO CHAT CODE**: Do NOT write code blocks in the text response. ONLY use the tools (\`createFile\`, \`updateFile\`) to generate code.
        5. **CONTEXT**: You see the files provided in context. If you need to edit them, use \`updateFile\`.

        Current Context Files:
        ${contextFiles.length > 0 ? contextFiles.map(f => f?.title).join(', ') : 'No files selected.'}
        `;

        try {
            const apiKey = process.env.API_KEY;
            if (!apiKey) {
                dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: 'Error: API Key not found.' } } });
                return;
            }

            const ai = new GoogleGenAI({ apiKey });
            const fullPrompt = `User Query: ${text}\n\nContext Files Content:\n${fileContext}`;

            dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: '' } } });

            // USE STRONGER MODEL FOR COMPLEX LOGIC
            const result = await ai.models.generateContentStream({
                model: 'gemini-3-flash-preview', 
                contents: fullPrompt,
                config: {
                    systemInstruction,
                    tools: [{ functionDeclarations: [createFileFunction, connectFilesFunction, updateCodeFunction, renameFileFunction, deleteFileFunction] }]
                }
            });

            let fullText = '';
            const functionCalls: any[] = [];

            for await (const chunk of result) {
                if (chunk.text) {
                    fullText += chunk.text;
                    dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
                if (chunk.functionCalls) {
                    functionCalls.push(...chunk.functionCalls);
                }
            }

            let toolOutputText = '';
            
            // Map to track filename changes within this single turn
            const filenameMap = new Map<string, string>(); // currentName -> nodeId
            
            // Initialize map with current state to ensure we can find existing files
            state.nodes.forEach(n => {
                if (n.type === 'CODE') {
                    filenameMap.set(n.title, n.id);
                }
            });

            if (functionCalls.length > 0) {
                for (const call of functionCalls) {
                    try {
                        if (call.name === 'createFile') {
                            const args = call.args as { filename: string, content: string, fileType?: string };
                            
                            // Check if file already exists to avoid dupes
                            if (filenameMap.has(args.filename)) {
                                toolOutputText += `\n[File ${args.filename} already exists, updating...]`;
                                const existingId = filenameMap.get(args.filename)!;
                                dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: existingId, content: args.content } });
                            } else {
                                const newId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                                const defaults = NODE_DEFAULTS.CODE;
                                
                                // Smart Positioning
                                const chatPos = node!.position;
                                const offsetIdx = filenameMap.size % 5;
                                // Place new nodes to the left/right of chat
                                const position = { x: chatPos.x - 450, y: chatPos.y + (offsetIdx * 50) };

                                const newNode: NodeData = {
                                    id: newId,
                                    type: 'CODE',
                                    title: args.filename,
                                    content: args.content || '// New file',
                                    position,
                                    size: { width: defaults.width, height: defaults.height },
                                    autoHeight: false
                                };

                                dispatchLocal({ type: 'ADD_NODE', payload: newNode });
                                filenameMap.set(args.filename, newId);
                                
                                // Trigger Shimmer on new node
                                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: newId, isLoading: true } });
                                idsToShimmer.push(newId);
                                toolOutputText += `\n[Created ${args.filename}]`;
                            }

                        } else if (call.name === 'connectFiles') {
                            const args = call.args as { sourceFilename: string, targetFilename: string };
                            const sourceId = filenameMap.get(args.sourceFilename);
                            const targetId = filenameMap.get(args.targetFilename);

                            if (sourceId && targetId) {
                                const sourcePortId = `${sourceId}-out-dom`;
                                const targetPortId = `${targetId}-in-file`;

                                dispatchLocal({
                                    type: 'CONNECT',
                                    payload: {
                                        id: `conn-${Date.now()}-${Math.random()}`,
                                        sourceNodeId: sourceId,
                                        sourcePortId: sourcePortId,
                                        targetNodeId: targetId,
                                        targetPortId: targetPortId
                                    }
                                });
                                toolOutputText += `\n[Connected ${args.sourceFilename} -> ${args.targetFilename}]`;
                            } else {
                                toolOutputText += `\n[Error: Could not connect ${args.sourceFilename}. File not found.]`;
                            }

                        } else if (call.name === 'updateFile') {
                            const args = call.args as { filename: string, code: string };
                            const nodeId = filenameMap.get(args.filename);

                            if (nodeId) {
                                dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: args.code } });
                                toolOutputText += `\n[Updated ${args.filename}]`;
                            } else {
                                toolOutputText += `\n[Error: Could not find file ${args.filename}]`;
                            }
                        } else if (call.name === 'renameFile') {
                            const args = call.args as { oldFilename: string, newFilename: string };
                            const nodeId = filenameMap.get(args.oldFilename);
                            
                            if (nodeId) {
                                dispatchLocal({ type: 'UPDATE_NODE_TITLE', payload: { id: nodeId, title: args.newFilename } });
                                filenameMap.delete(args.oldFilename);
                                filenameMap.set(args.newFilename, nodeId);
                                toolOutputText += `\n[Renamed ${args.oldFilename} to ${args.newFilename}]`;
                            }
                        } else if (call.name === 'deleteFile') {
                            const args = call.args as { filename: string };
                            const nodeId = filenameMap.get(args.filename);
                            if (nodeId) {
                                dispatchLocal({ type: 'DELETE_NODE', payload: nodeId });
                                filenameMap.delete(args.filename);
                                toolOutputText += `\n[Deleted ${args.filename}]`;
                            }
                        }
                    } catch (e) {
                        console.error("Tool execution error", e);
                    }
                }
                
                if (toolOutputText) {
                    fullText += `\n${toolOutputText}`;
                    dispatchLocal({ type: 'UPDATE_LAST_MESSAGE', payload: { id: nodeId, text: fullText } });
                }
            }

        } catch (error: any) {
            console.error(error);
            dispatchLocal({ type: 'ADD_MESSAGE', payload: { id: nodeId, message: { role: 'model', text: `Error: ${error.message}` } } });
        } finally {
             idsToShimmer.forEach(id => {
                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id, isLoading: false } });
            });
        }
    };

    const handleAiGenerate = async (nodeId: string, action: 'optimize' | 'prompt', promptText?: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if (!node || node.type !== 'CODE') return;

        dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: true } });

        try {
            const apiKey = process.env.API_KEY;
            if (!apiKey) {
                alert('API Key not found.');
                dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
                return;
            }

            const ai = new GoogleGenAI({ apiKey });
            let systemInstruction = '';
            let userPrompt = '';

            if (action === 'optimize') {
                systemInstruction = `You are an expert developer. OPTIMIZE the code. Do NOT minify. Maintain functionality. Return ONLY the code.`;
                userPrompt = `Please optimize the following code:\n\n${node.content}`;
            } else {
                systemInstruction = `You are an expert developer. MODIFY the code as requested. Return ONLY the code.`;
                userPrompt = `User Request: ${promptText}\n\nCurrent Code:\n${node.content}`;
            }

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: userPrompt,
                config: { systemInstruction }
            });

            const rawText = response.text;
            if (rawText) {
                const cleanCode = rawText.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');
                dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: nodeId, content: cleanCode } });
            }

        } catch (error: any) {
            alert(`AI Error: ${error.message}`);
        } finally {
            dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: nodeId, isLoading: false } });
        }
    };

    const handleInjectImport = (sourceNodeId: string, packageName: string) => {
        const connections = state.connections.filter(c => c.sourceNodeId === sourceNodeId);
        let injectedCount = 0;

        connections.forEach(conn => {
            const targetNode = state.nodes.find(n => n.id === conn.targetNodeId);
            if (targetNode && targetNode.type === 'CODE') {
                const importStatement = `import * as ${packageName.replace(/[^a-zA-Z0-9]/g, '_')} from 'https://esm.sh/${packageName}';\n`;
                if (!targetNode.content.includes(`https://esm.sh/${packageName}`)) {
                    dispatchLocal({
                        type: 'UPDATE_NODE_CONTENT',
                        payload: {
                            id: targetNode.id,
                            content: importStatement + targetNode.content
                        }
                    });
                    injectedCount++;
                }
            }
        });

        if (injectedCount === 0) {
            alert('Connect this NPM node to a Code node first!');
        }
    };

    const handleFixError = async (nodeId: string, errorMsg: string) => {
        const node = state.nodes.find(n => n.id === nodeId);
        if(!node) return;

        const connectionsToTerminal = state.connections.filter(c => c.targetNodeId === nodeId);
        if (connectionsToTerminal.length === 0) return;

        const previewNodeId = connectionsToTerminal[0].sourceNodeId;
        const connectionsToPreview = state.connections.filter(c => c.targetNodeId === previewNodeId);
        
        const sources: NodeData[] = [];
        connectionsToPreview.forEach(c => {
            const deps = getRelatedNodes(c.sourceNodeId, state.nodes, state.connections, 'CODE');
            sources.push(...deps);
        });
        
        const uniqueSources = Array.from(new Set(sources.map(n => n.id))).map(id => state.nodes.find(n => n.id === id)!);
        if (uniqueSources.length === 0) return;

        const fileContext = uniqueSources.map(n => `Filename: ${n!.title}\nContent:\n${n!.content}`).join('\n\n');
        
        uniqueSources.forEach(s => {
             dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: s.id, isLoading: true } });
        });

        const apiKey = process.env.API_KEY;
        if (!apiKey) return;

        const ai = new GoogleGenAI({ apiKey });
        const systemInstruction = `You are an automated error fixer. Analyze the error and fix it using 'updateFile'.`;
        const prompt = `Error Message: ${errorMsg}\n\nFiles:\n${fileContext}\n\nFix the error using the updateFile tool.`;
        
        try {
             const response = await ai.models.generateContent({
                 model: 'gemini-3-flash-preview',
                 contents: prompt,
                 config: { systemInstruction, tools: [{ functionDeclarations: [updateCodeFunction] }] }
             });

             const calls = response.functionCalls;
             if (calls) {
                 for (const call of calls) {
                     if (call.name === 'updateFile') {
                        const args = call.args as { filename: string, code: string };
                        const target = state.nodes.find(n => n.title === args.filename && n.type === 'CODE');
                        if (target) {
                            dispatchLocal({ type: 'UPDATE_NODE_CONTENT', payload: { id: target.id, content: args.code } });
                        }
                     }
                 }
             }
        } catch (e) { console.error(e); }
        finally {
             uniqueSources.forEach(s => dispatchLocal({ type: 'SET_NODE_LOADING', payload: { id: s.id, isLoading: false } }));
        }
    };

    return {
        handleSendMessage,
        handleAiGenerate,
        handleInjectImport,
        handleFixError
    };
};