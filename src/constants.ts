
import { NodeType, Port } from './types';

export const NODE_DEFAULTS = {
  CODE: { width: 450, height: 300, title: 'script.js', content: '// Write HTML, CSS, or JS here', autoHeight: false },
  PREVIEW: { width: 500, height: 400, title: 'Preview Output', content: '' },
  TERMINAL: { width: 400, height: 200, title: 'Terminal', content: '' },
  AI_CHAT: { width: 350, height: 450, title: 'AI Assistant', content: '' },
  NPM: { width: 300, height: 350, title: 'NPM Packages', content: '' },
  IMAGE: { width: 300, height: 300, title: 'Image', content: '' },
  TEXT: { width: 300, height: 300, title: 'Note.md', content: '# New Note\n\nDouble-click to edit this markdown note.', autoHeight: false },
  FOLDER: { width: 250, height: 300, title: 'components', content: '' },
};

export const getPortsForNode = (nodeId: string, type: NodeType): Port[] => {
  switch (type) {
    case 'CODE':
      return [
        { id: `${nodeId}-in-file`, nodeId, type: 'input', label: 'Imports', accepts: ['CODE', 'NPM', 'FOLDER'] },
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
    case 'NPM':
      return [
        { id: `${nodeId}-out-pkg`, nodeId, type: 'output', label: 'Package' },
      ];
    case 'FOLDER':
        return [
            { id: `${nodeId}-in-files`, nodeId, type: 'input', label: 'Files', accepts: ['CODE', 'IMAGE', 'TEXT'] },
            { id: `${nodeId}-out-folder`, nodeId, type: 'output', label: 'Export' },
        ];
    case 'AI_CHAT':
    case 'IMAGE':
    case 'TEXT':
        return [];
    default:
      return [];
  }
};
