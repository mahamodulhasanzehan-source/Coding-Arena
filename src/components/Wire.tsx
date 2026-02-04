
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

  if (active) {
      return (
        <g style={{ pointerEvents: 'none' }}>
            {/* The Wire Line: Grey and solid as requested */}
            <path
                d={path}
                fill="none"
                stroke="#71717a" // Zinc-500
                strokeWidth={12} // Increased thickness (was 6)
            />
            {/* The "Dot" being dragged */}
            <circle 
                cx={x2} 
                cy={y2} 
                r={8} 
                fill="#fbbf24" // Amber-400
                stroke="#18181b" 
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
        strokeWidth={8} // Increased thickness (was 4)
        className="transition-colors duration-200"
      />
    </g>
  );
};
