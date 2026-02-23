import { useRef, useEffect } from 'react';
import Waviz from 'waviz/core';

interface WavizVisualizerProps {
  stream: MediaStream | null;
  active: boolean;
}

export function WavizVisualizer({ stream, active }: WavizVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wavizRef = useRef<InstanceType<typeof Waviz> | null>(null);

  useEffect(() => {
    if (!stream || !canvasRef.current || !active) {
      if (wavizRef.current) {
        wavizRef.current.cleanup();
        wavizRef.current = null;
      }
      return;
    }
    const canvas = canvasRef.current;
    const waviz = new Waviz(canvas, stream);
    wavizRef.current = waviz;
    waviz
      .simpleBars('#4f46e5')
      .catch(() => {});
    return () => {
      waviz.cleanup();
      wavizRef.current = null;
    };
  }, [stream, active]);

  if (!active) {
    return (
      <div className="waviz-visualizer waviz-visualizer--idle">
        <p>Start interpretation to see audio levels.</p>
      </div>
    );
  }

  return (
    <div className="waviz-visualizer">
      <canvas
        ref={canvasRef}
        width={320}
        height={80}
        className="waviz-visualizer__canvas"
        aria-hidden
      />
    </div>
  );
}
