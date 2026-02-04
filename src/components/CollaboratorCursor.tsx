import React from 'react';
import { MousePointer2 } from 'lucide-react';

interface CollaboratorCursorProps {
  x: number;
  y: number;
  color: string;
  name?: string;
}

export const CollaboratorCursor: React.FC<CollaboratorCursorProps> = ({ x, y, color, name }) => {
  return (
    <div
      className="absolute pointer-events-none z-[1000] transition-transform duration-100 ease-linear flex flex-col items-start"
      style={{
        transform: `translate(${x}px, ${y}px)`,
      }}
    >
      <MousePointer2 
        size={16} 
        fill={color} 
        color={color} 
        className="drop-shadow-sm" 
      />
      {name && (
        <div 
            className="ml-4 px-2 py-0.5 rounded text-[10px] font-bold text-white shadow-md whitespace-nowrap animate-in fade-in slide-in-from-left-2"
            style={{ backgroundColor: color }}
        >
            {name}
        </div>
      )}
    </div>
  );
};