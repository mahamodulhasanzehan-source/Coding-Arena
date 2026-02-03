import React from 'react';

interface WireProps {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  active?: boolean;
}

export const Wire: React.FC<WireProps> = ({ x1, y1, x2, y2, active }) => {
  const dist = Math.abs(x2 - x1);
  const controlOffset = Math.max(dist * 0.5, 50);
  
  // Simple Bezier for connections
  const path = `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`;

  if (active) {
      return (
        <g style={{ pointerEvents: 'none' }}>
            {/* The Wire Line */}
            <path
                d={path}
                fill="none"
                stroke="#fbbf24" // Amber-400
                strokeWidth={3}
                strokeDasharray="5,5" // Dashed line for active drag
                className="opacity-80"
            />
            {/* The "Dot" being dragged */}
            <circle 
                cx={x2} 
                cy={y2} 
                r={6} 
                fill="#fbbf24" 
                stroke="#000" 
                strokeWidth={2}
            />
        </g>
      );
  }

  return (
    <g style={{ pointerEvents: 'none' }}>
      <path
        d={path}
        fill="none"
        stroke="#52525b" // Zinc-600
        strokeWidth={2}
        className="transition-colors duration-200"
      />
    </g>
  );
};