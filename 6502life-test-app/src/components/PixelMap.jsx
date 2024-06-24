import { useState, useRef, useEffect, useCallback } from 'react';
import csscolors from 'css-color-names';

import { useBoardUtils, focusCssColor } from './boardUtils.js';

export default function PixelMap(props) {
    let { size, pixelsPerCell, overviewBuffer, icons, onPaint, onHover, background, focusRect, selectedType, ...otherProps } = props;
    const { onMouseDown, onMouseUp, onMouseLeave, onMouseEnterCell } = useBoardUtils({ onPaint, onHover });
    const cursor = typeof(selectedType) === 'undefined' ? 'move' : 'pointer';

    const canvasRef = useRef(null);    

    const focusRectCssColor = focusCssColor;

    useEffect(() => {
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        let idata = context.createImageData(size, size);
        idata.data.set(overviewBuffer);
        context.putImageData(idata, 0, 0);
        if (focusRect) {
            context.fillStyle = focusRectCssColor;
            for (let x = -size; x < 2*size; x += size)
                for (let y = -size; y < 2*size; y += size)
                    context.fillRect (focusRect.left + x, focusRect.top + y, focusRect.width - 1, focusRect.height - 1);
        }
    }, [size, overviewBuffer]);
    
    const onMouseMove = useCallback ((evt) => {
        const rect = evt.target.getBoundingClientRect();
        const x = Math.floor((evt.clientX - rect.left) / pixelsPerCell);
        const y = Math.floor((evt.clientY - rect.top) / pixelsPerCell);
        onMouseEnterCell(x,y);
    }, [pixelsPerCell, onMouseEnterCell]);

    pixelsPerCell = pixelsPerCell || 1;
    const cssSize = size * pixelsPerCell;
    return (<div className="PixelMap" style={{cursor}}><canvas ref={canvasRef} width={size} height={size} style={{width:cssSize,height:cssSize}} {...otherProps} onMouseDown={onMouseDown()} onMouseUp={onMouseUp} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}/></div>);
}