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
  
  const path = `M ${x1} ${y1} C ${x1 + controlOffset} ${y1}, ${x2 - controlOffset} ${y2}, ${x2} ${y2}`;

  return (
    <g>
      {/* Shadow/Outline for better visibility */}
      <path
        d={path}
        fill="none"
        stroke={active ? '#fbbf24' : '#000'}
        strokeWidth={active ? 6 : 4}
        strokeOpacity={0.5}
      />
      {/* Main wire */}
      <path
        d={path}
        fill="none"
        stroke={active ? '#fbbf24' : '#71717a'}
        strokeWidth={2}
        className="transition-colors duration-200"
      />
    </g>
  );
};
