import { useState, useCallback } from 'react';
//import Textarea from 'rc-textarea';
//import Input from 'rc-input';
//import DebounceInput from 'react-debounce-input';
import csscolors from 'css-color-names';

import TiledBoard from './components/TiledBoard.jsx';
import PixelMap from './components/PixelMap.jsx';

import './App.css';

const defaultBackgroundColor = 'black';
const moveIcon = "oi:move";
const cssColorNames = Object.keys(csscolors).filter ((color) => color !== 'black' && color !== 'transparent' && color.indexOf('white') < 0).sort();

const clockSpeedMHz = 2;
const callbackRateHz = 100;
const targetCyclesPerCallback = (clockSpeedMHz * 1e6) / callbackRateHz;
const timerInterval = 1000 / callbackRateHz;  // ms

export default function App (props) {
  let { controller, visualizer } = props;
  let [totalCycles, setTotalCycles] = useState(0);
  let [hoverCell, setHoverCell] = useState(undefined);
    let [navState, setNavState] = useState({top:0,left:0,pixelsPerTile:32,tilesPerSide:8});
    let [timers] = useState({boardUpdateTimer:null});
    let [icons, setIcons] = useState({bee: {name: 'bee', color: 'orange'}});
    let [moveCounter, setMoveCounter] = useState(0);  // hacky way to force updates without cloning Board object
    let [selectedType, setSelectedType] = useState(undefined);
    let [errorMessage, setErrorMessage] = useState(undefined);
    let [importFile, setImportFile] = useState();

    const cellName = visualizer.getCellNameArray (navState.left, navState.top, navState.tilesPerSide + 1, navState.tilesPerSide + 1);
    const overviewBuffer = visualizer.getOverviewPixelBuffer();
//    const detailBuffer = visualizer.getDetailPixelBuffer (navState.left, navState.top, navState.tilesPerSide, navState.tilesPerSide);

    const background = defaultBackgroundColor;
    const forceUpdate = useCallback (() => setMoveCounter(moveCounter+1), [moveCounter]);

    const startTimer = useCallback (() => {
      timers.boardUpdateTimer = setTimeout (timers.timerFunc, timerInterval);
    }, [timers]);
    const stopTimer = useCallback (() => {
      if (timers.boardUpdateTimer)
        clearTimeout(timers.boardUpdateTimer);
      timers.boardUpdateTimer = null;
    }, [timers]);
    const pause = useCallback (() => {
      stopTimer();
      forceUpdate();
    }, [stopTimer, forceUpdate]);
    const resume = useCallback (() => {
      stopTimer();
      startTimer();
      forceUpdate();
    }, [stopTimer, startTimer, forceUpdate]);
    timers.timerFunc = useCallback (() => {
      let totalSchedulerCycles = 0;
      while (totalSchedulerCycles < targetCyclesPerCallback) {
          const { schedulerCycles } = controller.runToNextInterrupt();
          totalSchedulerCycles += schedulerCycles;
      }
      setTotalCycles (totalCycles + totalSchedulerCycles);
      startTimer();
    }, [controller, startTimer, totalCycles, setTotalCycles, forceUpdate]);
    
    const onPauseRestart = timers.boardUpdateTimer ? pause : resume;

    const wrapCoord = useCallback ((coord) => {
      while (coord < 0) coord += controller.memory.B;
      return coord % controller.memory.B;
    }, [controller.memory.B]);

    const paint = useCallback (({ x, y }) => {
      // TODO: write selectedType to cell (x,y)
      forceUpdate();
    }, [selectedType, controller, forceUpdate]);

    const tiledBoardPaint = useCallback (({ x, y }) => {
      if (selectedType)
        paint({ x, y });
      else {
        // TODO: select cell
      }
    }, [selectedType, paint]);

    const centerMap = useCallback (({ x, y }) => {
      const offset = navState.tilesPerSide >> 1;
      setNavState ({ ...navState, left: wrapCoord (x - offset), top: wrapCoord (y - offset) })
    }, [navState, wrapCoord]);

    const pixelMapPaint = useCallback (({ x, y }) => {
      if (selectedType)
        paint({ x, y });
      else
        centerMap ({ x, y });
    }, [selectedType, paint, centerMap]);

    const onDrag = useCallback ((dx, dy) => {
      if (selectedType !== undefined) return;
      setNavState ({...navState, left: wrapCoord(navState.left - Math.round(dx)), top: wrapCoord(navState.top - Math.round(dy))});
    }, [navState, wrapCoord, selectedType]);

    const mapPixelsPerCell = Math.max (1, Math.floor (navState.pixelsPerTile * navState.tilesPerSide / controller.memory.B));


return (
<div className="App" tabIndex="0">
<div className="NavigationPanel">
<TiledBoard
  controller={controller}
  size={controller.memory.B}
  cellName={cellName}
  onPaint={tiledBoardPaint} 
  onHover={setHoverCell}
  onDrag={onDrag}
  pixelsPerTile={navState.pixelsPerTile} 
  tilesPerSide={navState.tilesPerSide} 
  top={navState.top}
  left={navState.left}
  hoverCell={hoverCell}
  selectedType={selectedType}
  background={background}/>
<PixelMap 
  overviewBuffer={overviewBuffer}
  size={controller.memory.B} 
  onPaint={pixelMapPaint} 
  onHover={setHoverCell}
  selectedType={selectedType}
  pixelsPerCell={mapPixelsPerCell} 
  focusRect={{top:navState.top,left:navState.left,width:navState.tilesPerSide+2,height:navState.tilesPerSide+2}}
  background={background}/>
</div>
<div><span>Cycles: {totalCycles}</span></div>
<div><span>{hoverCell ? (<i>Cell ({hoverCell.x},{hoverCell.y})</i>) : (<i>Hover over cell to see state</i>)}</span></div>
<button onClick={onPauseRestart}>{timers.boardUpdateTimer ? "Pause" : "Start"}</button>
<button onClick={()=>{
  const json = {icons,selectedType,navState};
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(json)],{type:'application/json'}));
  a.download = 'board.json';
  a.click();
}}>Export</button>
<input type="file" onChange={(evt)=>setImportFile(evt.target.files[0])}/>
{importFile ? (<button onClick={()=>{
  const reader = new FileReader();
  reader.onload = (evt) => {
    const json = JSON.parse(evt.target.result);
    const {icons,selectedType,navState} = json;
    controller.memory.state = boardJson;
    setIcons(icons);
    setSelectedType(selectedType);
    setNavState(navState);
    setImportFile(undefined);
  };
  reader.readAsText(importFile);
}}>Import</button>) : ''}
</div>
);
}