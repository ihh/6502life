import { useState, useCallback, useRef, useEffect } from 'react';

export function useSimulation(controller) {
    const [running, setRunning] = useState(false);
    const [totalCycles, setTotalCycles] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [interruptCount, setInterruptCount] = useState(0);
    const intervalRef = useRef(null);
    const controllerRef = useRef(controller);
    const interruptCountRef = useRef(0);
    controllerRef.current = controller;

    const step = useCallback(() => {
        if (!controllerRef.current) return;
        const { schedulerCycles } = controllerRef.current.runToNextInterrupt();
        interruptCountRef.current++;
        setTotalCycles(controllerRef.current.totalCycles);
        setInterruptCount(interruptCountRef.current);
    }, []);

    const start = useCallback(() => {
        if (intervalRef.current || !controllerRef.current) return;
        setRunning(true);

        const targetCyclesPerTick = Math.max(100, 1e6 * speed / 60);
        intervalRef.current = setInterval(() => {
            const ctrl = controllerRef.current;
            if (!ctrl) return;
            let cyclesBudget = targetCyclesPerTick;
            while (cyclesBudget > 0) {
                const { schedulerCycles } = ctrl.runToNextInterrupt();
                cyclesBudget -= schedulerCycles;
                interruptCountRef.current++;
            }
            setTotalCycles(ctrl.totalCycles);
            setInterruptCount(interruptCountRef.current);
        }, 16);
    }, [speed]);

    const stop = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }
        setRunning(false);
    }, []);

    // Restart if speed changes while running
    useEffect(() => {
        if (running) {
            stop();
            // Use setTimeout to avoid immediate re-render issues
            setTimeout(() => start(), 0);
        }
    }, [speed]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, []);

    return { running, totalCycles, interruptCount, speed, step, start, stop, setSpeed };
}
