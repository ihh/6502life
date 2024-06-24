import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

import {BoardController} from './board/controller.js';
import {BoardVisualizer} from './board/visualizer.js';

let controller = new BoardController();
let visualizer = new BoardVisualizer(controller);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App controller={controller} visualizer={visualizer} />
  </React.StrictMode>,
)
