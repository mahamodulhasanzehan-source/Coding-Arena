import { NodeType, Port } from './types';

export const NODE_DEFAULTS = {
  HTML: { width: 400, height: 300, title: 'index.html', content: '<h1>Hello World</h1>\n<div id="app"></div>' },
  CSS: { width: 350, height: 250, title: 'style.css', content: 'body {\n  background: #111;\n  color: #eee;\n  font-family: sans-serif;\n}' },
  JS: { width: 350, height: 250, title: 'script.js', content: 'console.log("Script loaded");' },
  PREVIEW: { width: 500, height: 400, title: 'Preview Output', content: '' },
  TERMINAL: { width: 400, height: 200, title: 'Terminal', content: '' },
};

export const getPortsForNode = (nodeId: string, type: NodeType): Port[] => {
  switch (type) {
    case 'HTML':
      return [
        { id: `${nodeId}-in-css`, nodeId, type: 'input', label: 'CSS', accepts: ['CSS'] },
        { id: `${nodeId}-in-js`, nodeId, type: 'input', label: 'JS', accepts: ['JS'] },
        { id: `${nodeId}-out-dom`, nodeId, type: 'output', label: 'DOM' },
      ];
    case 'CSS':
      return [
        { id: `${nodeId}-out-css`, nodeId, type: 'output', label: 'CSS' },
      ];
    case 'JS':
      return [
        { id: `${nodeId}-out-js`, nodeId, type: 'output', label: 'JS' },
      ];
    case 'PREVIEW':
      return [
        { id: `${nodeId}-in-dom`, nodeId, type: 'input', label: 'DOM', accepts: ['HTML'] },
        { id: `${nodeId}-out-logs`, nodeId, type: 'output', label: 'Logs' },
      ];
    case 'TERMINAL':
      return [
        { id: `${nodeId}-in-logs`, nodeId, type: 'input', label: 'Source', accepts: ['PREVIEW'] },
      ];
    default:
      return [];
  }
};
