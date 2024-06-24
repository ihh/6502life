import { useState, useRef, useCallback } from 'react';
import Tile from './Tile.jsx';
import { useBoardUtils, focusCssColor } from './boardUtils.js';
import './TiledBoard.css';

export default function TiledBoard(props) {
    const { size, cellName, onPaint, onDrag, onHover, pixelsPerTile, tilesPerSide, top, left, hoverCell, selectedType, background } = props;

    const onDragWrap = useCallback ((x, y, stateAtMouseDown) => {
        x = x / pixelsPerTile + left - stateAtMouseDown.left;
        y = y / pixelsPerTile + top - stateAtMouseDown.top;
        if (onDrag)
            onDrag(x,y);
    }, [pixelsPerTile, left, top, onDrag]);
    const { onMouseDown, onMouseUp, onMouseLeave, onMouseMove, onMouseEnterCell, mouseDown } = useBoardUtils ({ onPaint, onHover, onDrag: onDragWrap });
    const cursor = typeof(selectedType)==='undefined' ? (mouseDown ? 'grabbing' : 'grab') : 'pointer';

    const offsetIndex = new Array(tilesPerSide+1).fill(0).map((_,n)=>n);
    const offsetToX = useCallback ((x) => (x + left) % size, [left, size]);
    const offsetToY = useCallback ((y) => (y + top) % size, [top, size]);

    const [fontSize, innerSize, outerSize, offset] = [1, tilesPerSide+1, tilesPerSide, -1/2].map ((s) => s * pixelsPerTile);
    const focusColor = focusCssColor;

return (
<>
<div className="TiledBoard" style={{width:outerSize,height:outerSize,cursor}}>
<div className="TiledBoardInner" onMouseDown={onMouseDown({top,left})} onMouseUp={onMouseUp} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave} style={{fontSize,width:innerSize,height:innerSize,top:offset,left:offset,background}}>
{cellName.map((cellNameRow,yOffset) => (<div className="tileRow" key={'tiledBoardRow'+yOffset}>
    {cellNameRow.map(((name,xOffset) => {
        const x = offsetToX(xOffset);
        const y = offsetToY(yOffset);
        return (<Tile 
            key={'tiledBoardRow'+y+'Cell'+x} 
            onMouseEnter={()=>onMouseEnterCell(x,y)} 
            name={name} 
            focusColor={focusColor}
            hover={hoverCell?.x === x && hoverCell?.y === y}
            />)
    }))}
    </div>))}
</div>
</div>
</>
);
}