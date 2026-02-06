import { FunctionDeclaration, Type } from "@google/genai";

export const createFileFunction: FunctionDeclaration = {
    name: 'createFile',
    description: 'Create a new code file (node) in the workspace. CRITICAL: Use this to split code into modules (e.g. creating style.css or game.js). Do not put CSS/JS in HTML unless very small.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: { type: Type.STRING, description: 'Name of the file (e.g. script.js)' },
            content: { type: Type.STRING, description: 'Initial content of the file.' },
            fileType: { type: Type.STRING, description: 'Type of node. Usually "CODE".', enum: ['CODE'] }
        },
        required: ['filename', 'content']
    }
};

export const connectFilesFunction: FunctionDeclaration = {
    name: 'connectFiles',
    description: 'Connect two files together using wires. Use this to link CSS/JS to HTML or other dependencies. Source is the dependency (e.g. style.css), Target is the importer (e.g. index.html).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            sourceFilename: { type: Type.STRING, description: 'The file providing functionality (e.g. style.css, script.js)' },
            targetFilename: { type: Type.STRING, description: 'The file importing functionality (e.g. index.html)' }
        },
        required: ['sourceFilename', 'targetFilename']
    }
};

export const updateCodeFunction: FunctionDeclaration = {
    name: 'updateFile',
    description: 'Update the code content of a specific file. Use this to write code or make changes. ALWAYS provide the FULL content of the file, not just the diff.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: {
                type: Type.STRING,
                description: 'The exact name of the file to update (e.g., script.js, index.html).'
            },
            code: {
                type: Type.STRING,
                description: 'The NEW full content of the file. Do not reduce code size unless optimizing. Maintain existing functionality.'
            }
        },
        required: ['filename', 'code']
    }
};

export const renameFileFunction: FunctionDeclaration = {
    name: 'renameFile',
    description: 'Rename a specific file node. Use this to change file extensions (e.g., .js to .html) or rename files entirely.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            oldFilename: {
                type: Type.STRING,
                description: 'The current name of the file.'
            },
            newFilename: {
                type: Type.STRING,
                description: 'The new name for the file.'
            }
        },
        required: ['oldFilename', 'newFilename']
    }
};

export const deleteFileFunction: FunctionDeclaration = {
    name: 'deleteFile',
    description: 'Delete a specific file/node from the workspace. Use this to remove useless, redundant, or incorrect code modules.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            filename: {
                type: Type.STRING,
                description: 'The name of the file to delete.'
            }
        },
        required: ['filename']
    }
};