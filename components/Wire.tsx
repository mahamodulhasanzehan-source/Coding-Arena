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
  
  // Bezier curve
  const path = `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`;

  return (
    <g style={{ pointerEvents: 'none' }}>
      <path
        d={path}
        fill="none"
        stroke={active ? '#fbbf24' : '#52525b'} // Zinc-600 for normal, Amber-400 for active/temp
        strokeWidth={active ? 3 : 2}
        className="transition-colors duration-200 animate-in fade-in duration-500"
      />
    </g>
  );
};