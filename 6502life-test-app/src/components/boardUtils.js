import { useState, useCallback } from 'react';
import { fromString, fromRgba } from 'css-color-converter';

const useBoardUtils = (opts) => {
    const { onPaint, onHover, onDrag } = opts;

    let [mouseState, setMouseState] = useState({mouseDown:false});
    let [mouseCell, setMouseCell] = useState({});

    const onMouseDown = useCallback ((stateAtMouseDown) => (evt) => {
        const origClientX = evt.clientX;
        const origClientY = evt.clientY;
        setMouseState({mouseDown:true,origClientX,origClientY,stateAtMouseDown});
        onPaint && onPaint({ x: mouseCell.x, y: mouseCell.y });
    }, [onPaint, mouseCell]);
    const onMouseUp = useCallback (() => setMouseState({mouseDown:false}), []);
    const onMouseLeave = useCallback (() => {
        onHover && onHover(undefined);
        onMouseUp();
    }, [onHover]);
    const onMouseMove = useCallback ((evt) => {
        if (mouseState.mouseDown && onDrag) {
            const x = evt.clientX;
            const y = evt.clientY;
            onDrag (x-mouseState.origClientX, y-mouseState.origClientY, mouseState.stateAtMouseDown);
        }
    }, [onDrag, mouseState]);
    const onMouseEnterCell = useCallback ((x, y) => {
        setMouseCell ({x, y});
        mouseState.mouseDown && onPaint && onPaint({x, y}); 
        onHover && onHover({x, y});
    }, [onPaint, onHover, mouseState]);

    return { onMouseDown, onMouseUp, onMouseMove, onMouseLeave, onMouseEnterCell, mouseDown: mouseState.mouseDown };
}

const focusCssColor = 'red';


export { useBoardUtils, focusCssColor };
