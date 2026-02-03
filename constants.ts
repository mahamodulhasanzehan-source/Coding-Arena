import { NodeType, Port } from './types';

export const NODE_DEFAULTS = {
  CODE: { width: 400, height: 150, title: 'script.js', content: '// Write HTML, CSS, or JS here', autoHeight: true },
  PREVIEW: { width: 500, height: 400, title: 'Preview Output', content: '' },
  TERMINAL: { width: 400, height: 200, title: 'Terminal', content: '' },
};

export const getPortsForNode = (nodeId: string, type: NodeType): Port[] => {
  switch (type) {
    case 'CODE':
      return [
        { id: `${nodeId}-in-file`, nodeId, type: 'input', label: 'Imports', accepts: ['CODE'] },
        { id: `${nodeId}-out-dom`, nodeId, type: 'output', label: 'DOM/File' },
      ];
    case 'PREVIEW':
      return [
        { id: `${nodeId}-in-dom`, nodeId, type: 'input', label: 'DOM', accepts: ['CODE'] },
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